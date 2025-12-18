#!/usr/bin/env ruby
# frozen_string_literal: true

require "webrick"
require "json"
require "net/http"
require "uri"
require "openssl"
require "time"

ROOT = File.expand_path(__dir__)
PUBLIC_DIR = File.join(ROOT, "public")

def load_dotenv(path)
  return unless File.exist?(path)

  File.read(path).split(/\r?\n/).each do |line|
    t = line.strip
    next if t.empty? || t.start_with?("#")

    k, v = t.split("=", 2)
    next if k.nil? || v.nil?

    k = k.strip
    v = v.strip
    if (v.start_with?('"') && v.end_with?('"')) || (v.start_with?("'") && v.end_with?("'"))
      v = v[1..-2]
    end
    ENV[k] = v if ENV[k].nil? || ENV[k].empty?
  end
end

load_dotenv(File.join(ROOT, ".env"))

PORT = (ENV["PORT"] || "8787").to_i

def normalize_openai_model(raw)
  v = raw.to_s.strip
  return "gpt-5.2" if v.empty?
  return "gpt-5.2" if v == "5.2"
  v
end

OPENAI_API_KEY = ENV["OPENAI_API_KEY"].to_s
OPENAI_BASE_URL = (ENV["OPENAI_BASE_URL"] || "https://api.openai.com/v1").to_s.sub(%r{/+\z}, "")
OPENAI_MODEL = normalize_openai_model(ENV["OPENAI_MODEL"])

PERPLEXITY_API_KEY = ENV["PERPLEXITY_API_KEY"].to_s
PERPLEXITY_BASE_URL = (ENV["PERPLEXITY_BASE_URL"] || "https://api.perplexity.ai").to_s.sub(%r{/+\z}, "")
PERPLEXITY_MODEL = (ENV["PERPLEXITY_MODEL"] || "sonar").to_s

def json(res, status, obj)
  res.status = status
  res["Content-Type"] = "application/json; charset=utf-8"
  res["Cache-Control"] = "no-store"
  res.body = JSON.generate(obj)
end

def clamp_str(v, max_len)
  v.to_s[0, max_len]
end

def try_parse_json(text)
  JSON.parse(text)
rescue StandardError
  nil
end

def parse_ohlcv_csv(text)
  lines = text.split(/\r?\n/).map(&:strip).reject(&:empty?)
  return nil if lines.length < 2

  header = lines[0].split(",").map { |s| s.strip.downcase }
  idx = ->(name) { header.index(name) }
  t_idx = idx.call("time") || idx.call("date")
  o_idx = idx.call("open")
  h_idx = idx.call("high")
  l_idx = idx.call("low")
  c_idx = idx.call("close")
  v_idx = idx.call("volume")
  return nil if t_idx.nil? || o_idx.nil? || h_idx.nil? || l_idx.nil? || c_idx.nil?

  out = []
  lines[1, 200].each do |line|
    cols = line.split(",").map(&:strip)
    t = cols[t_idx]
    o = Float(cols[o_idx]) rescue nil
    h = Float(cols[h_idx]) rescue nil
    l = Float(cols[l_idx]) rescue nil
    c = Float(cols[c_idx]) rescue nil
    v = v_idx ? (Float(cols[v_idx]) rescue nil) : nil
    next if t.nil? || t.empty? || o.nil? || h.nil? || l.nil? || c.nil?

    out << { "t" => t, "o" => o, "h" => h, "l" => l, "c" => c, "v" => v }
  end
  out.empty? ? nil : out
end

def normalize_ohlcv(text)
  raw = clamp_str(text, 200_000).strip
  return nil if raw.empty?

  parsed = try_parse_json(raw)
  if parsed.is_a?(Array)
    out = []
    parsed.first(200).each do |row|
      next unless row.is_a?(Hash)
      t = row["t"] || row["time"] || row["date"] || row["timestamp"]
      o = row["o"] || row["open"]
      h = row["h"] || row["high"]
      l = row["l"] || row["low"]
      c = row["c"] || row["close"]
      v = row.key?("v") ? row["v"] : row["volume"]
      next if t.nil?
      begin
        o_n = Float(o)
        h_n = Float(h)
        l_n = Float(l)
        c_n = Float(c)
      rescue StandardError
        next
      end
      v_n = begin
        v.nil? ? nil : Float(v)
      rescue StandardError
        nil
      end
      out << { "t" => t.to_s, "o" => o_n, "h" => h_n, "l" => l_n, "c" => c_n, "v" => v_n }
    end
    return out.empty? ? nil : out
  end

  parse_ohlcv_csv(raw)
end

def normalize_screener(text)
  raw = clamp_str(text, 200_000).strip
  return nil if raw.empty?

  parsed = try_parse_json(raw)
  return nil unless parsed.is_a?(Array)

  out = []
  parsed.first(50).each do |row|
    next unless row.is_a?(Hash)
    keys = row.keys.first(24)
    slim = {}
    keys.each { |k| slim[k] = row[k] }
    out << slim
  end
  out.empty? ? nil : out
end

def tv_symbol_to_yahoo(sym)
  s = sym.to_s.strip
  return "AAPL" if s.empty?
  parts = s.split(":")
  (parts.length > 1 ? parts[1] : parts[0]).strip
end

def safe_yahoo_symbol?(sym)
  !!(/\A[A-Za-z0-9.\-^=_]{1,32}\z/ =~ sym)
end

def safe_yahoo_interval?(v)
  !!(/\A(1m|2m|5m|15m|30m|60m|90m|1h|1d|5d|1wk|1mo|3mo)\z/ =~ v)
end

def safe_yahoo_range?(v)
  !!(/\A(1d|5d|1mo|3mo|6mo|1y|2y|5y|10y|ytd|max)\z/ =~ v)
end

def http_json_post(url, headers, payload)
  uri = URI(url)
  http = Net::HTTP.new(uri.host, uri.port)
  http.use_ssl = (uri.scheme == "https")
  http.verify_mode = OpenSSL::SSL::VERIFY_PEER
  req = Net::HTTP::Post.new(uri.request_uri)
  headers.each { |k, v| req[k] = v }
  req.body = JSON.generate(payload)
  resp = http.request(req)
  [resp.code.to_i, resp.body.to_s]
end

def extract_assistant_text_from_chat_completions(data)
  choice = data.is_a?(Hash) ? (data["choices"].is_a?(Array) ? data["choices"][0] : nil) : nil
  msg = choice.is_a?(Hash) ? choice["message"] : nil

  c = msg.is_a?(Hash) ? msg["content"] : nil
  return c if c.is_a?(String)

  r = msg.is_a?(Hash) ? msg["refusal"] : nil
  return r if r.is_a?(String) && !r.empty?

  if c.is_a?(Array)
    parts = c.map do |p|
      if p.is_a?(String)
        p
      elsif p.is_a?(Hash)
        p["text"].is_a?(String) ? p["text"] : (p["content"].is_a?(String) ? p["content"] : "")
      else
        ""
      end
    end
    return parts.join
  end

  t = choice.is_a?(Hash) ? choice["text"] : nil
  return t if t.is_a?(String)

  ot = data.is_a?(Hash) ? data["output_text"] : nil
  return ot if ot.is_a?(String)

  ""
end

def http_get(url, headers = {})
  uri = URI(url)
  http = Net::HTTP.new(uri.host, uri.port)
  http.use_ssl = (uri.scheme == "https")
  http.verify_mode = OpenSSL::SSL::VERIFY_PEER
  req = Net::HTTP::Get.new(uri.request_uri)
  headers.each { |k, v| req[k] = v }
  resp = http.request(req)
  [resp.code.to_i, resp.body.to_s]
end

server = WEBrick::HTTPServer.new(
  Port: PORT,
  BindAddress: "127.0.0.1",
  AccessLog: [],
  Logger: WEBrick::Log.new($stdout, WEBrick::Log::INFO)
)

server.mount_proc "/api/health" do |_req, res|
  json(res, 200, {
    ok: true,
    openai: !OPENAI_API_KEY.empty?,
    perplexity: !PERPLEXITY_API_KEY.empty?
  })
end

server.mount_proc "/api/yahoo/ohlcv" do |req, res|
  unless req.request_method == "GET"
    json(res, 405, { ok: false, error: "Method Not Allowed" })
    next
  end

  symbol = tv_symbol_to_yahoo(req.query["symbol"] || "AAPL")
  interval = (req.query["interval"] || "1d").to_s
  range = (req.query["range"] || "6mo").to_s

  unless safe_yahoo_symbol?(symbol) && safe_yahoo_interval?(interval) && safe_yahoo_range?(range)
    json(res, 400, { ok: false, error: "Invalid params" })
    next
  end

  yahoo_url = "https://query1.finance.yahoo.com/v8/finance/chart/#{URI.encode_www_form_component(symbol)}" \
              "?interval=#{URI.encode_www_form_component(interval)}&range=#{URI.encode_www_form_component(range)}" \
              "&includePrePost=false&events=div%7Csplit"

  status, body = http_get(yahoo_url, { "User-Agent" => "Mozilla/5.0" })
  unless status.between?(200, 299)
    json(res, 502, { ok: false, error: "Yahoo request failed", status: status, details: body[0, 2000] })
    next
  end

  data = try_parse_json(body)
  result = data.dig("chart", "result", 0) rescue nil
  ts = result&.dig("timestamp") || []
  quote = result&.dig("indicators", "quote", 0) || {}
  opens = quote["open"] || []
  highs = quote["high"] || []
  lows = quote["low"] || []
  closes = quote["close"] || []
  vols = quote["volume"] || []

  candles = []
  ts.each_with_index do |t, i|
    break if candles.length >= 200
    o = opens[i]
    h = highs[i]
    l = lows[i]
    c = closes[i]
    v = vols[i]
    next unless [o, h, l, c].all? { |x| x.is_a?(Numeric) && x.finite? }
    iso = Time.at(t.to_i).utc.iso8601 rescue Time.at(t.to_i).utc.to_s
    candles << { t: iso, o: o, h: h, l: l, c: c, v: (v.is_a?(Numeric) && v.finite?) ? v : nil }
  end

  json(res, 200, { ok: true, source: "yahoo", symbol: symbol, interval: interval, range: range, candles: candles })
end

server.mount_proc "/api/explain" do |req, res|
  unless req.request_method == "POST"
    json(res, 405, { ok: false, error: "Method Not Allowed" })
    next
  end

  payload = try_parse_json(req.body.to_s) || {}
  symbol = clamp_str(payload["symbol"] || "NASDAQ:AAPL", 64)
  interval = clamp_str(payload["interval"] || "D", 16)
  user_notes = clamp_str(payload["userNotes"] || "", 4000)
  question = clamp_str(payload["question"] || "", 2000)
  ohlcv_norm = normalize_ohlcv(payload["ohlcv"] || "")
  screener_norm = normalize_screener(payload["screener"] || "")

  system = [
    "당신은 트레이딩 해설 보조자입니다.",
    "사용자가 제공한 심볼/타임프레임/메모 및 (선택) OHLCV/스크리너 데이터를 바탕으로 교육 목적의 설명을 제공합니다.",
    "OHLCV가 없으면 수치 기반 단정은 피하고, 필요한 정보는 질문으로 되묻습니다.",
    "OHLCV가 있으면 간단한 추세/변동성/레벨 후보를 데이터 기반으로 설명하되, 예측을 단정하지 않습니다.",
    "투자 조언이 아니며, 리스크 관리(손절/포지션 사이징/시나리오) 관점에서 답합니다.",
    "",
    "출력 형식(항상 한국어, 마크다운):",
    "## 요약",
    "## 현재 구도(추세/변동성/모멘텀 가정)",
    "## 확인할 레벨(지지/저항 후보) — '추정'임을 명시",
    "## 가능한 시나리오(상승/하락/횡보)와 확인 신호",
    "## 리스크/주의사항",
    "## 사용자에게 되묻는 질문(부족한 정보 3개 이내)"
  ].join("\n")

  input_parts = [
    "심볼: #{symbol}",
    "타임프레임(TradingView interval): #{interval}",
    user_notes.empty? ? "사용자 메모/관찰: (없음)" : "사용자 메모/관찰:\n#{user_notes}",
    ohlcv_norm ? "OHLCV(최대 200봉):\n#{JSON.pretty_generate(ohlcv_norm)}" : "OHLCV: (없음/파싱 실패)",
    screener_norm ? "스크리너(최대 50행):\n#{JSON.pretty_generate(screener_norm)}" : "스크리너: (없음/파싱 실패)",
    question.empty? ? "요청/질문: (없음)" : "요청/질문:\n#{question}"
  ]
  input = input_parts.join("\n\n")

  if OPENAI_API_KEY.empty?
    if PERPLEXITY_API_KEY.empty?
      json(res, 200, {
        ok: true,
        mode: "mock",
        answer: "## 요약\n현재는 **OPENAI_API_KEY가 설정되지 않아** 예시 응답을 반환합니다.\n"
      })
      next
    end

    status, body = http_json_post(
      "#{PERPLEXITY_BASE_URL}/chat/completions",
      { "Authorization" => "Bearer #{PERPLEXITY_API_KEY}", "Content-Type" => "application/json" },
      {
        model: PERPLEXITY_MODEL,
        messages: [{ role: "system", content: system }, { role: "user", content: input }],
        temperature: 0.4,
        max_tokens: 900
      }
    )

    unless status.between?(200, 299)
      json(res, 502, { ok: false, error: "Perplexity request failed", status: status, details: body[0, 2000] })
      next
    end

    data = try_parse_json(body) || {}
    answer = extract_assistant_text_from_chat_completions(data).to_s
    citations = data["citations"].is_a?(Array) ? data["citations"] : []
    json(res, 200, { ok: true, mode: "perplexity", model: PERPLEXITY_MODEL, answer: answer, citations: citations })
    next
  end

  status, body = http_json_post(
    "#{OPENAI_BASE_URL}/chat/completions",
    { "Authorization" => "Bearer #{OPENAI_API_KEY}", "Content-Type" => "application/json" },
    {
      model: OPENAI_MODEL,
      messages: [{ role: "system", content: system }, { role: "user", content: input }],
      temperature: 0.4,
      max_completion_tokens: 800
    }
  )

  unless status.between?(200, 299)
    json(res, 502, { ok: false, error: "LLM request failed", status: status, details: body[0, 2000] })
    next
  end

  data = try_parse_json(body) || {}
  answer = extract_assistant_text_from_chat_completions(data).to_s

  if answer.strip.empty? && !PERPLEXITY_API_KEY.empty?
    # OpenAI가 빈 응답이면 Perplexity로 재시도
    p_status, p_body = http_json_post(
      "#{PERPLEXITY_BASE_URL}/chat/completions",
      { "Authorization" => "Bearer #{PERPLEXITY_API_KEY}", "Content-Type" => "application/json" },
      {
        model: PERPLEXITY_MODEL,
        messages: [{ role: "system", content: system }, { role: "user", content: input }],
        temperature: 0.4,
        max_tokens: 900
      }
    )

    unless p_status.between?(200, 299)
      json(res, 502, { ok: false, error: "Empty completion from OpenAI", status: p_status, details: p_body[0, 2000] })
      next
    end

    p_data = try_parse_json(p_body) || {}
    p_answer = extract_assistant_text_from_chat_completions(p_data).to_s
    p_citations = p_data["citations"].is_a?(Array) ? p_data["citations"] : []
    json(res, 200, { ok: true, mode: "perplexity", model: PERPLEXITY_MODEL, fallback_from: "openai_empty", answer: p_answer, citations: p_citations })
    next
  end

  json(res, 200, { ok: true, mode: "openai", model: OPENAI_MODEL, answer: answer })
end

server.mount_proc "/api/research" do |req, res|
  unless req.request_method == "POST"
    json(res, 405, { ok: false, error: "Method Not Allowed" })
    next
  end

  payload = try_parse_json(req.body.to_s) || {}
  symbol = clamp_str(payload["symbol"] || "NASDAQ:AAPL", 64)
  query = clamp_str(payload["query"] || payload["question"] || "", 2000).strip
  user_notes = clamp_str(payload["userNotes"] || "", 2000)

  if query.empty?
    json(res, 400, { ok: false, error: "query is required" })
    next
  end

  if PERPLEXITY_API_KEY.empty?
    json(res, 200, {
      ok: true,
      mode: "mock",
      answer: "## 리서치 요약\n현재는 **PERPLEXITY_API_KEY가 설정되지 않아** 예시 응답을 반환합니다.\n",
      citations: []
    })
    next
  end

  system = [
    "당신은 금융 리서치 보조자입니다. 사용자의 질문에 대해 웹 기반 정보를 요약합니다.",
    "과장/추측을 피하고, 사실/해석/불확실성을 구분합니다.",
    "가능하면 최신 정보 위주로 요약하고, 중요한 주장에는 출처(citations)가 있으면 함께 제시합니다.",
    "항상 한국어로, 간결한 마크다운으로 답합니다.",
    "",
    "출력 형식:",
    "## 리서치 요약",
    "## 핵심 포인트(3~7개)",
    "## 촉매/리스크(불확실성 포함)",
    "## 차트 관점에 연결되는 체크리스트(3~6개)",
    "## 출처(있으면)"
  ].join("\n")

  input = [
    "대상(심볼): #{symbol}",
    user_notes.empty? ? "사용자 메모(선택): (없음)" : "사용자 메모(선택):\n#{user_notes}",
    "질문:\n#{query}"
  ].join("\n\n")

  status, body = http_json_post(
    "#{PERPLEXITY_BASE_URL}/chat/completions",
    { "Authorization" => "Bearer #{PERPLEXITY_API_KEY}", "Content-Type" => "application/json" },
    {
      model: PERPLEXITY_MODEL,
      messages: [{ role: "system", content: system }, { role: "user", content: input }],
      temperature: 0.2,
      max_tokens: 900
    }
  )

  unless status.between?(200, 299)
    json(res, 502, { ok: false, error: "Perplexity request failed", status: status, details: body[0, 2000] })
    next
  end

  data = try_parse_json(body) || {}
  answer = data.dig("choices", 0, "message", "content").to_s
  citations = data["citations"].is_a?(Array) ? data["citations"] : []
  json(res, 200, { ok: true, mode: "perplexity", model: PERPLEXITY_MODEL, answer: answer, citations: citations })
end

# 정적 파일 서빙
server.mount "/", WEBrick::HTTPServlet::FileHandler, PUBLIC_DIR, { FancyIndexing: false }

trap("INT") { server.shutdown }

puts "Server running: http://localhost:#{PORT}"
puts "OpenAI: #{OPENAI_API_KEY.empty? ? "disabled (mock for /api/explain)" : "enabled"}"
puts "Perplexity: #{PERPLEXITY_API_KEY.empty? ? "disabled (mock for /api/research)" : "enabled"}"

server.start


