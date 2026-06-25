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

  resultBox.innerHTML = `
    <section class="risk-card ${risk}">
      <div class="risk-overview">
        <div>
      <span class="risk-label">${labels[risk]}</span>
      <h2>Phân tích kỹ thuật</h2>
      <p>${escapeHtml(detective.summary || "Nội dung này cần kiểm tra thêm.")}</p>
        </div>
        <div class="danger-meter" style="--score:${dangerPercent}%" aria-label="Mức nguy hiểm ${dangerPercent}%">
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
