import base64
import binascii
import json
import os
import re
import time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen

from flask import Flask, jsonify, render_template, request

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"

URL_RE = re.compile(r"(?:https?://|www\.)[^\s<>\"']+", re.IGNORECASE)
PHONE_RE = re.compile(r"(?<!\d)(?:\+?84|0)(?:[\s.-]*\d){8,10}(?!\d)")
IP_RE = re.compile(r"\d{1,3}(?:\.\d{1,3}){3}")
DANGER_RE = re.compile(
    r"otp|mã xác thực|ma xac thuc|mật khẩu|mat khau|chuyển khoản|chuyen khoan|"
    r"chuyển tiền|chuyen tien|nạp tiền|nap tien|cài app|cai app|tải app|tai app|"
    r"anydesk|teamviewer|điều khiển|dieu khien|khóa tài khoản|khoa tai khoan|"
    r"bị bắt|bi bat|công an|cong an",
    re.IGNORECASE,
)
RISKS = {"safe", "suspicious", "danger"}
CHOICES = {"none", "clicked", "transferred", "otp"}
IMAGE_TYPES = {"image/jpeg", "image/png", "image/webp"}
MAX_IMAGE_BYTES = 4 * 1024 * 1024

BAD_AI = "AI trả về dữ liệu không đúng định dạng. Bác vui lòng thử lại."
DEFAULT_ACTIONS = [
    "Không bấm đường dẫn và không cung cấp mã xác thực.",
    "Gọi tổng đài chính thức của ngân hàng được in trên thẻ.",
    "Lưu lại tin nhắn làm bằng chứng.",
]
SPOOF_PATTERNS = (
    "vietcornbank",
    "vietc0mbank",
    "vietcom-bank",
    "vietcombank-secure",
    "vietcombank-verify",
)


def load_env():
    env_file = BASE_DIR / ".env"
    if not env_file.exists():
        return
    for line in env_file.read_text(encoding="utf-8").splitlines():
        if line.strip() and not line.lstrip().startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip().strip("'\""))


load_env()

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 7_000_000


@app.after_request
def add_cors_headers(response):
    response.headers["Access-Control-Allow-Origin"] = os.getenv("CORS_ORIGIN", "*")
    response.headers["Access-Control-Allow-Headers"] = "Content-Type"
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    return response


def load_json(name):
    return json.loads((DATA_DIR / name).read_text(encoding="utf-8"))


def api_error(message, status):
    return jsonify(error=message), status


@app.get("/")
def index():
    return render_template("index.html", scam_types=load_json("scam_types.json"))


@app.get("/api/library")
def library():
    return jsonify(load_json("scam_types.json"))


@app.post("/api/analyze")
def analyze():
    body = request.get_json(silent=True) or {}
    message = str(body.get("message", "")).strip()

    try:
        image = validate_image(body.get("image"))
    except ValueError as error:
        return api_error(str(error), 400)

    if not message and not image:
        return api_error("Bác hãy dán tin nhắn hoặc chọn ảnh chụp màn hình cần kiểm tra.", 400)
    if len(message) > 5000:
        return api_error("Tin nhắn dài quá 5.000 ký tự. Bác hãy rút gọn rồi thử lại.", 400)

    try:
         detective = normalize_detective(
            call_gemini(detective_prompt(message, bool(image)), image, attempts=2),
            message,
        )
    except ValueError as error:
        return api_error(str(error), 502)

    psychology, psychology_error = None, None
    if detective["risk"] in {"suspicious", "danger"}:
        try:
            psychology = normalize_psychology(call_gemini(psychology_prompt(message, detective), attempts=2))
        except ValueError:
            psychology_error = "Cô tâm lý đang bận, vui lòng thử lại sau."

    return jsonify(
        detective=detective,
        psychology=psychology,
        psychologyError=psychology_error,
        links=inspect_links(message),
    )


@app.post("/api/rescue")
def rescue():
    choice = (request.get_json(silent=True) or {}).get("choice")
    if choice not in CHOICES:
        return api_error("Bác hãy chọn đúng tình huống đã xảy ra.", 400)
    if choice == "none":
        return jsonify(
            title="Bác đã dừng lại đúng lúc",
            steps=["Không bấm đường dẫn, không trả lời và xóa tin sau khi đã lưu bằng chứng."],
        )

    hotlines = [item for item in load_json("hotlines.json") if item.get("verified")]
    allowed_phones = {normalize_phone(item["phone"]) for item in hotlines}

    try:
        result = normalize_rescue(call_gemini(rescue_prompt(choice, hotlines), attempts=2))
    except ValueError as error:
        return api_error(str(error), 502)

    generated = {
        normalize_phone(phone)
        for phone in PHONE_RE.findall(json.dumps(result, ensure_ascii=False))
    }
    if generated - allowed_phones:
        return api_error(
            "AI đã trả về số chưa có trong bảng đã xác minh nên ScamCheck đã chặn kết quả.",
            502,
        )
    return jsonify(result)


def call_gemini(prompt, image=None, attempts=1, models=None):
    key = os.getenv("GEMINI_API_KEY", "").strip()
    if not key:
        raise ValueError("Máy chủ chưa được cấu hình GEMINI_API_KEY.")

    configured_model = os.getenv("GEMINI_MODEL", "gemini-2.5-flash").strip()
    models = models or list(dict.fromkeys([configured_model, "gemini-3.1-flash-lite"]))

    for model in models:
        for attempt in range(attempts):
            try:
                response = urlopen(gemini_request(key, model, prompt, image), timeout=9)
                data = json.loads(response.read().decode())
                raw = data["candidates"][0]["content"]["parts"][0]["text"]
                return parse_ai_json(raw)
            except HTTPError as error:
                if error.code == 429:
                    break
                if error.code in {500, 502, 503, 504} and attempt + 1 < attempts:
                    time.sleep(0.8)
                    continue
                raise gemini_http_error(error, model) from error
            except (URLError, TimeoutError) as error:
                if attempt + 1 < attempts:
                    time.sleep(0.8)
                    continue
                raise ValueError("Kết nối từ máy chủ Flask tới Gemini bị gián đoạn. Bác vui lòng gửi lại.") from error
            except (KeyError, IndexError, json.JSONDecodeError) as error:
                raise ValueError(BAD_AI) from error

    raise ValueError("AI đang giới hạn lượt gọi. Bác vui lòng thử lại sau.")


def gemini_request(key, model, prompt, image=None):
    parts = [{"text": prompt}]
    if image:
        parts.append({"inline_data": {"mime_type": image["mimeType"], "data": image["data"]}})

    payload = json.dumps({
        "contents": [{"parts": parts}],
        "generationConfig": {"responseMimeType": "application/json"},
    }).encode()
    endpoint = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={key}"
    return Request(endpoint, data=payload, headers={"Content-Type": "application/json"})


def gemini_http_error(error, model):
    detail = ""
    try:
        detail = json.loads(error.read().decode()).get("error", {}).get("message", "")
    except (json.JSONDecodeError, UnicodeDecodeError):
        pass

    if error.code in {401, 403}:
        return ValueError("Gemini API key không hợp lệ hoặc chưa được cấp quyền.")
    if error.code == 404:
        return ValueError(f"Không tìm thấy model Gemini '{model}'.")
    if error.code == 400:
        return ValueError(f"Gemini từ chối yêu cầu không hợp lệ: {detail[:240] or 'không có chi tiết'}.")
    return ValueError(f"Gemini trả lỗi HTTP {error.code}. Bác vui lòng thử lại.")


def parse_ai_json(raw):
    if isinstance(raw, dict):
        return raw

    text = str(raw).strip()
    text = text.removeprefix("```json").removeprefix("```").removesuffix("```").strip()
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end < start:
        raise ValueError(BAD_AI)

    try:
        parsed = json.loads(text[start:end + 1])
    except json.JSONDecodeError as error:
        raise ValueError(BAD_AI) from error

    if not isinstance(parsed, dict):
        raise ValueError(BAD_AI)
    return parsed


def validate_image(value):
    if not value:
        return None
    if (
        not isinstance(value, dict)
        or value.get("mimeType") not in IMAGE_TYPES
        or not isinstance(value.get("data"), str)
    ):
        raise ValueError("Ảnh phải là tệp PNG, JPG hoặc WebP.")

    try:
        decoded = base64.b64decode(value["data"], validate=True)
    except (binascii.Error, ValueError) as error:
        raise ValueError("Dữ liệu ảnh không hợp lệ.") from error

    if not decoded:
        raise ValueError("Ảnh chụp màn hình đang trống.")
    if len(decoded) > MAX_IMAGE_BYTES:
        raise ValueError("Ảnh lớn quá 4 MB. Bác hãy chọn ảnh nhỏ hơn.")
    return {"mimeType": value["mimeType"], "data": value["data"]}


def normalize_phone(value):
    raw = str(value).strip()
    digits = re.sub(r"\D", "", raw)
    return f"0{digits[2:]}" if raw.startswith("+84") else digits


def normalize_detective(data, message = ""):
    signs = []
    for item in data.get("signs", [])[:5] if isinstance(data.get("signs"), list) else []:
        if isinstance(item, dict):
            signs.append({
                "reason": str(item.get("reason") or "Dấu hiệu cần kiểm tra thêm."),
                "quote": str(item.get("quote") or ""),
            })

    actions = [str(item) for item in data.get("actions", [])[:3]] if isinstance(data.get("actions"), list) else []
    actions += DEFAULT_ACTIONS[len(actions):]

    risk = data.get("risk") if data.get("risk") in RISKS else "suspicious"
    risk == "danger" and message and not has_danger_trigger(message):
        risk = "suspicious"
    return {
        "risk": risk
        "summary": str(data.get("summary") or "Nội dung này cần được kiểm tra thêm."),
        "signs": signs,
        "actions": actions[:3],
    }

def has_danger_trigger(message):
    return bool(URL_RE.search(message) or DANGER_RE.search(message))
    
def normalize_psychology(data):
    message = str(data.get("message") or "").strip()
    if not message:
        raise ValueError("Thiếu phản hồi")
    sentences = [part.strip() for part in re.split(r"(?<=[.!?])\s+", message) if part.strip()]
    return " ".join(sentences[:3])


def normalize_rescue(data):
    cleaned = []
    steps = data.get("steps") if isinstance(data.get("steps"), list) else []
    for item in steps[:6]:
        if isinstance(item, dict):
            cleaned.append({
                "action": str(item.get("action") or "Thực hiện bước này ngay."),
                "script": str(item.get("script") or "Tôi cần được hỗ trợ xử lý một vụ việc nghi lừa đảo."),
            })

    if not cleaned:
        raise ValueError("Người ứng cứu trả về dữ liệu không đúng định dạng.")
    return {"title": str(data.get("title") or "Các bước cần làm ngay"), "steps": cleaned}


def inspect_links(message):
    results = []
    for raw in URL_RE.findall(message):
        clean = raw.rstrip(".,;:!?)]}")
        parsed = urlparse(clean if clean.startswith("http") else f"https://{clean}")
        host = (parsed.hostname or "").lower()
        results.append({"url": clean, "domain": host, "warning": link_warnings(host)})
    return results


def link_warnings(host):
    warnings = []
    if host.startswith("xn--") or ".xn--" in host:
        warnings.append("Tên miền dùng ký tự mã hóa dễ gây nhầm lẫn.")
    if IP_RE.fullmatch(host):
        warnings.append("Đường dẫn dùng địa chỉ số thay vì tên miền tổ chức.")
    if any(pattern in host for pattern in SPOOF_PATTERNS):
        warnings.append("Tên miền có dấu hiệu thay ký tự hoặc thêm từ để giả mạo Vietcombank.")
    return warnings or ["Chưa thấy mẫu giả mạo cục bộ; vẫn cần kiểm tra qua kênh chính thức."]


def detective_prompt(message, has_image=False):
    image_note = "có" if has_image else "không"
    content = message or "(không có; hãy đọc chữ trong ảnh chụp màn hình)"
    return f'''Bạn là Thám tử ScamCheck. Giọng khô khan, lý tính. Phân tích kỹ thuật tin nhắn tiếng Việt.
Trả về duy nhất JSON: {{"risk":"safe|suspicious|danger","summary":"1-2 câu","signs":[{{"reason":"lý do","quote":"trích nguyên văn từ tin"}}],"actions":["đúng 3 hành động"]}}.
Quy tắc phân loại:
- safe: nội dung đời thường, không yêu cầu tiền, mã xác thực, thông tin cá nhân, cài app hoặc bấm link lạ.
- suspicious: có dấu hiệu đáng ngờ như tự xưng nhân viên/cơ quan, hỏi thông tin chung, hỏi tên ngân hàng, thúc
         giục nhẹ, hoặc yêu cầu kiểm tra tài khoản; nhưng chưa có link lạ, chưa yêu cầu OTP/mật khẩu, chưa yêu cầu chuyển tiền, chưa yêu cầu cài app.
- danger: chỉ dùng khi có link lạ/giả mạo, yêu cầu OTP/mật khẩu, yêu cầu chuyển tiền, yêu cầu cài app/điều khiể
         n máy, mạo danh công an, đe dọa khóa tài khoản/bắt giữ, hoặc cấm người dùng gọi kênh chính thức.
Không xếp danger chỉ vì người gửi tự xưng nhân viên hỗ trợ hoặc hỏi bác đang dùng ngân hàng nào; trường hợp đó là suspicious.
Không bịa chi tiết. Mỗi quote phải có nguyên văn trong tin hoặc đọc được rõ trong ảnh.
Ảnh chụp màn hình được gửi kèm: {image_note}.
Nội dung người dùng nhập: {content}'''


def psychology_prompt(message, detective):
    return f'''Bạn là Cô tâm lý. Xưng “cô”, gọi người dùng là “bác”. Viết 2-3 câu gần gũi, không hù dọa, không dạy dỗ; giải thích chiêu thức cảm xúc khiến người đọc suýt tin.
Trả về duy nhất JSON: {{"message":"2-3 câu"}}.
Tin: {message}
Kết luận Thám tử: {json.dumps(detective, ensure_ascii=False)}'''


def rescue_prompt(choice, hotlines):
    labels = {
        "clicked": "đã bấm vào đường dẫn",
        "transferred": "đã chuyển khoản",
        "otp": "đã cung cấp mã xác thực",
    }
    return f'''Bạn là Người ứng cứu. Người dùng {labels[choice]}. Giọng bình tĩnh, dứt khoát; không phân tích, không an ủi, chỉ nêu hành động.
Mỗi bước phải có câu nói mẫu để bác đọc khi gọi điện. Chỉ được dùng số trong bảng sau; nếu bảng trống, không viết bất kỳ số điện thoại nào và hướng dẫn gọi số chính thức in trên thẻ ngân hàng: {json.dumps(hotlines, ensure_ascii=False)}
Trả về duy nhất JSON: {{"title":"tiêu đề","steps":[{{"action":"việc làm","script":"câu nói mẫu"}}]}}.'''


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=7000)
