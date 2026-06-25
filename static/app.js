const HISTORY_KEY = "scamcheck-history-v1";
const message = document.querySelector("#message");
const analyzeButton = document.querySelector("#analyze");
const errorBox = document.querySelector("#form-error");
const loading = document.querySelector("#loading");
const resultBox = document.querySelector("#result");
const screenshotInput = document.querySelector("#screenshot");
const imagePreview = document.querySelector("#image-preview");
const API_BASE = (document.querySelector('meta[name="api-base"]')?.content || "").replace(/\/$/, "");
let history = readHistory();
let library = [];
let selectedImage = null;
let currentShare = null
document.querySelectorAll("[data-page]").forEach((button) => {
  button.addEventListener("click", (event) => {
    event.preventDefault();
    showPage(button.dataset.page);
  });
});

document.querySelectorAll("[data-sample]").forEach((button) => {
  button.addEventListener("click", () => {
    clearImage();
    message.value = button.dataset.sample;
    updateCount();
    message.focus();
  });
});

message.addEventListener("input", updateCount);
analyzeButton.addEventListener("click", analyze);
document.querySelector("#voice").addEventListener("click", startVoice);
document.querySelector("#remove-image").addEventListener("click", clearImage);
screenshotInput.addEventListener("change", selectImage);
document.querySelector("#clear-history").addEventListener("click", () => {
  history = [];
  localStorage.removeItem(HISTORY_KEY);
  renderHistory();
});

async function analyze() {
  const value = message.value.trim();
  setError("");
  if (!value && !selectedImage) return setError("Bác hãy dán tin nhắn hoặc chọn ảnh chụp màn hình cần kiểm tra.");
  if (value.length > 5000) return setError("Tin nhắn dài quá 5.000 ký tự.");

  analyzeButton.disabled = true;
  loading.hidden = false;
  resultBox.hidden = true;
  try {
    const response = await fetch(apiUrl("/api/analyze"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: value, image: selectedImage }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "ScamCheck chưa thể phân tích lúc này.");
    if (!data.detective) throw new Error("AI trả về dữ liệu không đúng định dạng.");
    renderResult(data, value);
    saveHistory(value, data, Boolean(selectedImage));
  } catch (error) {
    setError(error.message || "Mất kết nối. Bác hãy kiểm tra mạng rồi thử lại.");
  } finally {
    analyzeButton.disabled = false;
    loading.hidden = true;
  }
}

function renderResult(data, originalMessage) {
  const detective = data.detective;
  const risk = ["safe", "suspicious", "danger"].includes(detective.risk) ? detective.risk : "suspicious";
  const labels = { safe: "An toàn", suspicious: "Nguy cơ", danger: "Nguy hiểm" };
  const signs = Array.isArray(detective.signs) ? detective.signs : [];
  const actions = Array.isArray(detective.actions) ? detective.actions.slice(0, 3) : [];
  const links = Array.isArray(data.links) ? data.links : [];
  const dangerPercent = dangerScore(risk, signs, links);
  currentShare = { message: originalMessage || "", data, savedAt: new Date().toISOString() };
  const shareLink = makeShareLink(currentShare);
  resultBox.innerHTML = `
    <section class="risk-card ${risk}">
      <div class="risk-overview">
        <div>
      <span class="risk-label">${labels[risk]}</span>
      <h2>Phân tích kỹ thuật</h2>
      <p>${escapeHtml(detective.summary || "Nội dung này cần kiểm tra thêm.")}</p>
        </div>
        <div class="danger-meter" style="--score:${dangerPercent}%" aria-label="Mức nguy hiểm ${dangerPercent}%">
          <small>Biểu đồ</small>
          <strong>${dangerPercent}%</strong>
          <span>nguy hiểm</span>
        </div>
      </div>
    </section>
    <section>
      <h3>Dấu hiệu ScamCheck tìm thấy</h3>
      ${signs.length ? `<ul>${signs.map((item) => `<li><strong>${escapeHtml(item.reason)}</strong>${item.quote ? `<br>Trích: “${escapeHtml(item.quote)}”` : ""}</li>`).join("")}</ul>` : "<p>Chưa có dấu hiệu cụ thể; bác vẫn nên kiểm tra qua kênh chính thức.</p>"}
      ${originalMessage ? `<h3>Tin gốc đã tô dấu</h3><p>${highlight(originalMessage, signs.map((item) => item.quote).filter(Boolean))}</p>` : "<p><strong>ScamCheck đã đọc nội dung trực tiếp từ ảnh chụp màn hình.</strong></p>"}
    </section>
    <section>
      <h3>Ba việc nên làm tiếp theo</h3>
      <ol>${actions.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ol>
    </section>
    ${renderLinks(links)}
    ${data.psychology ? `<section class="psychology"><h3>Hiểu vì sao mình suýt tin — Cô tâm lý</h3><p>${escapeHtml(data.psychology)}</p></section>` : ""}
    ${data.psychologyError ? `<section class="psychology"><h3>Hiểu vì sao mình suýt tin</h3><p>${escapeHtml(data.psychologyError)}</p></section>` : ""}
    <section class="share-panel">
      <h3>Công cụ chia sẻ</h3>
      <p>Lưu link kết quả hoặc xuất cuộc hội thoại thành ảnh PNG khổ A4 để gửi file.</p>
      <label for="share-link">Link cuộc hội thoại</label>
      <div class="share-row">
        <input id="share-link" type="text" readonly value="${escapeHtml(shareLink)}">
        <button class="secondary" type="button" data-tool="copy-link">Sao chép link</button>
      </div>
      <div class="share-actions">
        <button class="secondary" type="button" data-tool="native-share">Chia sẻ</button>
        <button class="secondary" type="button" data-tool="export-a4">Tải ảnh A4</button>
      </div>
      <p id="share-status" class="share-status" aria-live="polite"></p>
    </section>
    <section id="rescue">
    <section id="rescue">
      <h3>Bác đã làm gì rồi?</h3>
      <p>Chọn một tình huống. Sau khi chọn, ScamCheck sẽ khóa lựa chọn để tránh nhầm lẫn.</p>
      <div class="rescue-choices">
        <button data-choice="none">Chưa làm gì</button>
        <button data-choice="clicked">Đã bấm vào đường dẫn</button>
        <button data-choice="transferred">Đã chuyển khoản</button>
        <button data-choice="otp">Đã cung cấp mã xác thực</button>
      </div>
      <div id="rescue-result" aria-live="polite"></div>
    </section>`;
  resultBox.hidden = false;
  resultBox.querySelectorAll("[data-choice]").forEach((button) => {
    button.addEventListener("click", () => requestRescue(button.dataset.choice, button));
  });
  resultBox.querySelector('[data-tool="copy-link"]')?.addEventListener("click", copyShareLink);
  resultBox.querySelector('[data-tool="native-share"]')?.addEventListener("click", nativeShare);
  resultBox.querySelector('[data-tool="export-a4"]')?.addEventListener("click", exportA4Image);
  resultBox.scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderLinks(links) {
  if (!links.length) return "";
  return `<section><h3>Soi đường dẫn</h3>${links.map((item) => `
    <div class="link-card"><strong>${escapeHtml(item.domain || item.url)}</strong><br>
    ${item.warning.map(escapeHtml).join(" ")}</div>`).join("")}</section>`;
}

async function requestRescue(choice, selectedButton) {
  const buttons = resultBox.querySelectorAll("[data-choice]");
  buttons.forEach((button) => { button.disabled = true; });
  selectedButton.classList.add("chosen");
  const target = document.querySelector("#rescue-result");
  target.innerHTML = "<p>Người ứng cứu đang chuẩn bị từng bước...</p>";
  try {
    const response = await fetch(apiUrl("/api/rescue"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ choice }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Người ứng cứu chưa thể phản hồi.");
    const rescue = data.result || data;
    const steps = rescue.steps || [];
    target.innerHTML = `<h3>${escapeHtml(rescue.title)}</h3><ol>${steps.map((step) => {
      if (typeof step === "string") return `<li>${escapeHtml(step)}</li>`;
      return `<li><strong>${escapeHtml(step.action)}</strong><br>Câu nói mẫu: “${escapeHtml(step.script)}”</li>`;
    }).join("")}</ol>`;
  } catch (error) {
    target.innerHTML = `<p class="error">${escapeHtml(error.message)}</p>`;
  }
}

function saveHistory(originalMessage, data, hasImage) {
  history.unshift({
    id: Date.now(),
    date: new Date().toISOString(),
    message: originalMessage || (hasImage ? "Ảnh chụp màn hình" : "Tin nhắn"),
    originalMessage,
    data,
  });
  history = history.slice(0, 10);
  localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  renderHistory();
}

function readHistory() {
  try {
    const value = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
    return Array.isArray(value) ? value.slice(0, 10) : [];
  } catch {
    return [];
  }
}

function renderHistory() {
  const target = document.querySelector("#history-list");
  if (!history.length) {
    target.innerHTML = '<p class="empty">Chưa có tin nào được lưu trên thiết bị này.</p>';
    return;
  }
  const labels = { safe: "An toàn", suspicious: "Nguy cơ", danger: "Nguy hiểm" };
  target.innerHTML = history.map((item) => `<button class="history-item" data-history="${item.id}">
    <strong>${labels[item.data?.detective?.risk] || "Nguy cơ"} · ${new Date(item.date).toLocaleString("vi-VN")}</strong>
    <span>${escapeHtml(item.message.slice(0, 130))}</span>
  </button>`).join("");
  target.querySelectorAll("[data-history]").forEach((button) => {
    button.addEventListener("click", () => {
      const item = history.find((entry) => String(entry.id) === button.dataset.history);
      if (!item) return;
      message.value = item.originalMessage ?? item.message;
      clearImage();
      updateCount();
      renderResult(item.data, item.originalMessage ?? item.message);
      showPage("check");
    });
  });
}

async function loadLibrary() {
  try {
    const response = await fetch(apiUrl("/api/library"));
    library = await response.json();
    renderFilters();
    renderLibrary("Tất cả");
  } catch {
    document.querySelector("#library-list").innerHTML = '<p class="error">Không thể mở thư viện lúc này.</p>';
  }
}

function renderFilters() {
  const categories = ["Tất cả", ...new Set(library.map((item) => item.category))];
  const target = document.querySelector("#filters");
  target.innerHTML = categories.map((category, index) => `<button class="${index === 0 ? "active" : ""}" data-filter="${escapeHtml(category)}">${escapeHtml(category)}</button>`).join("");
  target.querySelectorAll("[data-filter]").forEach((button) => {
    button.addEventListener("click", () => {
      target.querySelectorAll("button").forEach((item) => item.classList.remove("active"));
      button.classList.add("active");
      renderLibrary(button.dataset.filter);
    });
  });
}

function renderLibrary(category) {
  const items = category === "Tất cả" ? library : library.filter((item) => item.category === category);
  document.querySelector("#library-list").innerHTML = items.map((item) => `<article class="library-item">
    <p class="eyebrow">${escapeHtml(item.category)}</p>
    <h2>${escapeHtml(item.name)}</h2>
    <p>${escapeHtml(item.description)}</p>
    <details><summary>Xem ví dụ</summary><p class="example">${escapeHtml(item.example)}</p></details>
  </article>`).join("");
}

function showPage(name) {
  document.querySelectorAll(".page").forEach((page) => { page.hidden = true; page.classList.remove("active"); });
  const page = document.querySelector(`#page-${name}`);
  page.hidden = false;
  page.classList.add("active");
  document.querySelectorAll(".nav-button").forEach((button) => button.classList.toggle("active", button.dataset.page === name));
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function startVoice() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) return setError("Trình duyệt này chưa hỗ trợ nhập bằng giọng nói.");
  const recognition = new SpeechRecognition();
  recognition.lang = "vi-VN";
  recognition.interimResults = false;
  recognition.onresult = (event) => {
    message.value = `${message.value} ${event.results[0][0].transcript}`.trim().slice(0, 5000);
    updateCount();
  };
  recognition.onerror = () => setError("Không nghe được giọng nói. Bác có thể dán tin nhắn bằng tay.");
  recognition.start();
}

async function selectImage(event) {
  const file = event.target.files[0];
  if (!file) return;
  setError("");
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
    clearImage();
    return setError("Ảnh phải là tệp PNG, JPG hoặc WebP.");
  }
  if (file.size > 4 * 1024 * 1024) {
    clearImage();
    return setError("Ảnh lớn quá 4 MB. Bác hãy chọn ảnh nhỏ hơn.");
  }
  try {
    const dataUrl = await readFile(file);
    selectedImage = { mimeType: file.type, data: dataUrl.split(",", 2)[1] };
    imagePreview.querySelector("img").src = dataUrl;
    document.querySelector("#image-name").textContent = file.name;
    imagePreview.hidden = false;
  } catch (error) {
    clearImage();
    setError(error.message);
  }
}

function clearImage() {
  selectedImage = null;
  screenshotInput.value = "";
  imagePreview.querySelector("img").removeAttribute("src");
  imagePreview.hidden = true;
}

function readFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Không thể đọc ảnh này."));
    reader.readAsDataURL(file);
  });
}
Dưới đây là toàn bộ đoạn code của bạn sau khi đã loại bỏ các ký tự đánh dấu dòng (số dòng và dấu +) theo đúng định dạng được yêu cầu:

JavaScript
function makeShareLink(payload) {
  const url = new URL(window.location.href);
  url.hash = `share=${encodeShare(payload)}`;
  return url.toString();
}

function encodeShare(payload) {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  let binary = "";
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeShare(value) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

function loadSharedConversation() {
  if (!location.hash.startsWith("#share=")) return;
  try {
    const payload = decodeShare(location.hash.slice(7));
    if (!payload?.data?.detective) throw new Error("bad-share");
    message.value = payload.message || "";
    updateCount();
    renderResult(payload.data, payload.message || "");
    showPage("check");
    setShareStatus("Đã mở kết quả từ link chia sẻ.");
  } catch {
    setError("Link chia sẻ không hợp lệ hoặc đã bị cắt ngắn.");
  }
}

async function copyShareLink() {
  const input = document.querySelector("#share-link");
  if (!input) return;
  try {
    await navigator.clipboard.writeText(input.value);
    setShareStatus("Đã sao chép link.");
  } catch {
    input.select();
    document.execCommand("copy");
    setShareStatus("Đã sao chép link.");
  }
}

async function nativeShare() {
  const input = document.querySelector("#share-link");
  if (!input) return;
  if (navigator.share) {
    try {
      await navigator.share({ title: "Kết quả ScamCheck", text: "Kết quả kiểm tra ScamCheck", url: input.value });
      setShareStatus("Đã mở bảng chia sẻ.");
      return;
    } catch {
      return;
    }
  }
  await copyShareLink();
}

function exportA4Image() {
  if (!currentShare?.data?.detective) return setShareStatus("Chưa có kết quả để xuất ảnh.");

  const canvas = document.createElement("canvas");
  canvas.width = 1240;
  canvas.height = 1754;
  const ctx = canvas.getContext("2d");
  const data = currentShare.data;
  const detective = data.detective;
  const risk = detective.risk || "suspicious";
  const labels = { safe: "AN TOÀN", suspicious: "NGUY CƠ", danger: "NGUY HIỂM" };
  const colors = { safe: "#18794e", suspicious: "#8a5a00", danger: "#b42318" };
  const dangerPercent = dangerScore(risk, detective.signs || [], data.links || []);

  ctx.fillStyle = "#f7f3ea";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  roundRect(ctx, 70, 70, 1100, 1614, 34, "#ffffff");

  ctx.fillStyle = "#073d35";
  ctx.font = "700 44px Arial";
  ctx.fillText("ScamCheck", 110, 140);
  ctx.font = "400 24px Arial";
  ctx.fillStyle = "#53635f";
  ctx.fillText(new Date().toLocaleString("vi-VN"), 110, 178);

  drawMeter(ctx, 1010, 160, 92, dangerPercent, colors[risk]);
  ctx.fillStyle = colors[risk];
  ctx.font = "800 30px Arial";
  ctx.textAlign = "center";
  ctx.fillText(`${dangerPercent}%`, 1010, 155);
  ctx.font = "700 17px Arial";
  ctx.fillText("NGUY HIỂM", 1010, 183);
  ctx.textAlign = "left";

  roundRect(ctx, 110, 225, 1020, 96, 20, risk === "safe" ? "#d7f4e5" : risk === "danger" ? "#fee4e2" : "#fff1c2");
  ctx.fillStyle = colors[risk];
  ctx.font = "900 32px Arial";
  ctx.fillText(labels[risk] || "NGUY CƠ", 145, 285);

  let y = 380;
  y = drawBlock(ctx, "Tin cần kiểm tra", currentShare.message || "Ảnh chụp màn hình", 110, y, 1020, 5);
  y = drawBlock(ctx, "Phân tích kỹ thuật", detective.summary || "Nội dung này cần được kiểm tra thêm.", 110, y + 18, 1020, 5);

  const signs = Array.isArray(detective.signs) ? detective.signs : [];
  y = drawList(ctx, "Dấu hiệu tìm thấy", signs.map((item) => `${item.reason}${item.quote ? ` — “${item.quote}”` : ""}`), 110, y + 18, 1020, 5);

  const actions = Array.isArray(detective.actions) ? detective.actions : [];
  y = drawList(ctx, "Ba việc nên làm", actions, 110, y + 18, 1020, 4);

  if (data.psychology) {
    y = drawBlock(ctx, "Cô tâm lý", data.psychology, 110, y + 18, 1020, 4);
  }

  ctx.fillStyle = "#53635f";
  ctx.font = "400 20px Arial";
  wrapCanvasText(ctx, "ScamCheck là công cụ giáo dục, không thay thế cảnh báo chính thức từ ngân hàng hoặc cơ quan chức năng.", 110, 1625, 1020, 28, 2);

  const link = document.createElement("a");
  link.download = `scamcheck-a4-${Date.now()}.png`;
  link.href = canvas.toDataURL("image/png");
  link.click();
  setShareStatus("Đã tạo ảnh A4 PNG.");
}

function drawBlock(ctx, title, body, x, y, width, maxLines) {
  ctx.fillStyle = "#0b5d4f";
  ctx.font = "800 25px Arial";
  ctx.fillText(title, x, y);
  ctx.fillStyle = "#14211e";
  ctx.font = "400 25px Arial";
  return wrapCanvasText(ctx, body, x, y + 38, width, 34, maxLines) + 20;
}

function drawList(ctx, title, items, x, y, width, maxItems) {
  ctx.fillStyle = "#0b5d4f";
  ctx.font = "800 25px Arial";
  ctx.fillText(title, x, y);
  ctx.fillStyle = "#14211e";
  ctx.font = "400 24px Arial";
  let nextY = y + 38;
  const shown = items.length ? items.slice(0, maxItems) : ["Chưa có dấu hiệu cụ thể."];
  shown.forEach((item, index) => {
    nextY = wrapCanvasText(ctx, `${index + 1}. ${item}`, x, nextY, width, 32, 2) + 8;
  });
  return nextY + 10;
}

function wrapCanvasText(ctx, text, x, y, maxWidth, lineHeight, maxLines = 6) {
  const words = String(text || "").split(/\s+/);
  const lines = [];
  let line = "";
  words.forEach((word) => {
    const testLine = line ? `${line} ${word}` : word;
    if (ctx.measureText(testLine).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = testLine;
    }
  });
  if (line) lines.push(line);
  lines.slice(0, maxLines).forEach((item, index) => {
    const suffix = index === maxLines - 1 && lines.length > maxLines ? "..." : "";
    ctx.fillText(item + suffix, x, y + index * lineHeight);
  });
  return y + Math.min(lines.length, maxLines) * lineHeight;
}

function roundRect(ctx, x, y, width, height, radius, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + width - radius, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
  ctx.lineTo(x + width, y + height - radius);
  ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  ctx.lineTo(x + radius, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.fill();
}

function drawMeter(ctx, x, y, radius, percent, color) {
  ctx.lineWidth = 22;
  ctx.strokeStyle = "#e8eeeb";
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, radius, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * percent / 100);
  ctx.stroke();
}

function setShareStatus(value) {
  const target = document.querySelector("#share-status");
  if (target) target.textContent = value;
}
function updateCount() { document.querySelector("#count").textContent = `${message.value.length.toLocaleString("vi-VN")} / 5.000`; }
function setError(value) { errorBox.textContent = value; errorBox.hidden = !value; }
function apiUrl(path) { return `${API_BASE}${path}`; }
function dangerScore(risk, signs, links) {
  const base = { safe: 12, suspicious: 55, danger: 85 }[risk] ?? 55;
  const signBonus = Math.min(signs.length * 3, 9);
  const linkBonus = Math.min(links.length * 4, 8);
  return Math.min(base + signBonus + linkBonus, 98);
}
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
}
function highlight(text, phrases) {
  const unique = [...new Set(phrases.map(String).filter(Boolean))].sort((a, b) => b.length - a.length);
  if (!unique.length) return escapeHtml(text);
  const pattern = unique.map((phrase) => phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const matches = new Set(unique.map((phrase) => phrase.toLocaleLowerCase("vi")));
  return String(text).split(new RegExp(`(${pattern})`, "gi")).map((part) =>
    matches.has(part.toLocaleLowerCase("vi")) ? `<mark>${escapeHtml(part)}</mark>` : escapeHtml(part)
  ).join("");
}

renderHistory();
loadLibrary();
updateCount();
loadSharedConversation();
