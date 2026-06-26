const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const API = ($('meta[name="api-base"]')?.content || "").replace(/\/$/, "");
const HISTORY = "scamcheck-history-v1";
const FONT = "scamcheck-font-size";

let selectedImage = null;
let current = null;
let history = JSON.parse(localStorage.getItem(HISTORY) || "[]");

const message = $("#message");
const result = $("#result");
const loading = $("#loading");
const errorBox = $("#form-error");
const screenshot = $("#screenshot");
const preview = $("#image-preview");

function api(path) { return API + path; }
function html(v) { return String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function score(risk, signs, links) { return Math.min(({ safe: 12, suspicious: 55, danger: 85 }[risk] || 55) + signs.length * 3 + links.length * 4, 98); }

function setPage(name) {
  const page = name === "link" ? "check" : name;
  $$(".page").forEach(x => { x.hidden = true; x.classList.remove("active"); });
  $("#page-" + page).hidden = false;
  $("#page-" + page).classList.add("active");
  $$(".nav-button").forEach(x => x.classList.toggle("active", x.dataset.page === name));
  document.body.classList.toggle("link-mode", name === "link");
  message.placeholder = name === "link" ? "Nhập link cần kiểm tra vào đây..." : "Dán tin nhắn SMS, Zalo, Messenger hoặc email vào đây...";
  if (name === "link") clearImage();
}

function setFont(size, save = false) {
  size = Math.max(16, Math.min(24, Number(size) || 18));
  document.documentElement.style.fontSize = size + "px";
  $("#font-size").value = size;
  $("#font-size-label").textContent = size + "px";
  if (save) localStorage.setItem(FONT, size);
}

async function analyze() {
  const text = message.value.trim();
  setError("");
  if (!text && !selectedImage) return setError("Bác hãy nhập nội dung hoặc chọn ảnh.");
  if (text.length > 5000) return setError("Tin nhắn dài quá 5.000 ký tự.");

  $("#analyze").disabled = true;
  loading.hidden = false;
  result.hidden = true;
  try {
    const res = await fetch(api("/api/analyze"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text, image: selectedImage }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Không phân tích được lúc này.");
    render(data, text);
    saveHistory(text || "Ảnh chụp màn hình", data);
  } catch (e) {
    setError(e.message);
  } finally {
    $("#analyze").disabled = false;
    loading.hidden = true;
  }
}

function render(data, text) {
  const d = data.detective || {};
  const risk = ["safe", "suspicious", "danger"].includes(d.risk) ? d.risk : "suspicious";
  const labels = { safe: "An toàn", suspicious: "Nguy cơ", danger: "Nguy hiểm" };
  const signs = Array.isArray(d.signs) ? d.signs : [];
  const actions = Array.isArray(d.actions) ? d.actions.slice(0, 3) : [];
  const links = Array.isArray(data.links) ? data.links : [];
  const pct = score(risk, signs, links);
  current = { text, data, pct, image: selectedImage };

  result.innerHTML = `
    <section class="risk-card ${risk}">
      <div class="risk-overview">
        <div><span class="risk-label">${labels[risk]}</span><h2>Phân tích kỹ thuật</h2><p>${html(d.summary || "Nội dung này cần kiểm tra thêm.")}</p></div>
        <div class="danger-meter" style="--score:${pct}%"><strong>${pct}%</strong></div>
      </div>
    </section>
    <section><h3>Dấu hiệu</h3>${signs.length ? `<ul>${signs.map(x => `<li><strong>${html(x.reason)}</strong>${x.quote ? `<br><mark>${html(x.quote)}</mark>` : ""}</li>`).join("")}</ul>` : "<p>Chưa có dấu hiệu cụ thể.</p>"}</section>
    <section><h3>Ba việc nên làm</h3><ol>${actions.map(x => `<li>${html(x)}</li>`).join("")}</ol></section>
    ${links.length ? `<section><h3>Link phát hiện</h3>${links.map(x => `<p class="link-card"><b>${html(x.domain || x.url)}</b><br>${(x.warning || []).map(html).join(" ")}</p>`).join("")}</section>` : ""}
    <section class="share-panel">
      <h3>Chia sẻ</h3>
      <div class="share-row"><input id="share-link" readonly value="${html(makeShare())}"><button class="secondary" type="button" id="copy-share">Sao chép link</button></div>
      <div class="share-actions"><button class="secondary" type="button" id="export-a4">Tải ảnh A4</button></div>
      <p id="share-status" class="share-status"></p>
    </section>`;
  result.hidden = false;
  $("#copy-share").onclick = copyShare;
  $("#export-a4").onclick = exportA4;
}

function makeShare() {
  const url = new URL(location.href);
  url.hash = "share=" + btoa(unescape(encodeURIComponent(JSON.stringify({ text: current.text, data: current.data })))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return url.toString();
}

function loadShare() {
  if (!location.hash.startsWith("#share=")) return;
  try {
    const raw = location.hash.slice(7).replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(decodeURIComponent(escape(atob(raw.padEnd(Math.ceil(raw.length / 4) * 4, "=")))));
    message.value = payload.text || "";
    render(payload.data, payload.text || "");
    setPage("check");
  } catch { setError("Link chia sẻ không hợp lệ."); }
}

function saveHistory(text, data) {
  history.unshift({ id: Date.now(), date: new Date().toISOString(), text, data });
  history = history.slice(0, 10);
  localStorage.setItem(HISTORY, JSON.stringify(history));
  renderHistory();
}

function renderHistory() {
  const labels = { safe: "An toàn", suspicious: "Nguy cơ", danger: "Nguy hiểm" };
  $("#history-list").innerHTML = history.length ? history.map(x => `<button class="history-item" data-id="${x.id}"><strong>${labels[x.data?.detective?.risk] || "Nguy cơ"} · ${new Date(x.date).toLocaleString("vi-VN")}</strong><span>${html(x.text).slice(0, 130)}</span></button>`).join("") : '<p class="empty">Chưa có lịch sử.</p>';
  $$(".history-item").forEach(b => b.onclick = () => {
    const item = history.find(x => String(x.id) === b.dataset.id);
    if (!item) return;
    message.value = item.text;
    render(item.data, item.text);
    setPage("check");
  });
}

async function loadLibrary() {
  try {
    const res = await fetch(api("/api/library"));
    const items = await res.json();
    const cats = ["Tất cả", ...new Set(items.map(x => x.category))];
    $("#filters").innerHTML = cats.map((c, i) => `<button class="${i ? "" : "active"}" data-cat="${html(c)}">${html(c)}</button>`).join("");
    const paint = (cat) => $("#library-list").innerHTML = (cat === "Tất cả" ? items : items.filter(x => x.category === cat)).map(x => `<article class="library-item"><p class="eyebrow">${html(x.category)}</p><h2>${html(x.name)}</h2><p>${html(x.description)}</p></article>`).join("");
    $("#filters").onclick = e => { if (!e.target.dataset.cat) return; $$("#filters button").forEach(b => b.classList.toggle("active", b === e.target)); paint(e.target.dataset.cat); };
    paint("Tất cả");
  } catch { $("#library-list").innerHTML = '<p class="error">Không mở được thư viện.</p>'; }
}

function selectImage(e) {
  const file = e.target.files[0];
  if (!file) return;
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) return setError("Ảnh phải là PNG, JPG hoặc WebP.");
  if (file.size > 4 * 1024 * 1024) return setError("Ảnh lớn quá 4 MB.");
  const reader = new FileReader();
  reader.onload = () => {
    const src = reader.result;
    selectedImage = { mimeType: file.type, data: src.split(",", 2)[1] };
    preview.querySelector("img").src = src;
    $("#image-name").textContent = file.name;
    preview.hidden = false;
  };
  reader.readAsDataURL(file);
}

function clearImage() {
  selectedImage = null;
  screenshot.value = "";
  preview.hidden = true;
  preview.querySelector("img").removeAttribute("src");
}

async function copyShare() {
  await navigator.clipboard.writeText($("#share-link").value);
  $("#share-status").textContent = "Đã sao chép link.";
}

async function exportA4() {
  if (!current) return;
  const c = document.createElement("canvas"), ctx = c.getContext("2d");
  c.width = 1240; c.height = 1754;
  ctx.fillStyle = "#f7f3ea"; ctx.fillRect(0, 0, c.width, c.height);
  ctx.fillStyle = "#fff"; ctx.fillRect(70, 70, 1100, 1614);
  ctx.fillStyle = "#073d35"; ctx.font = "700 54px Arial"; ctx.fillText("ScamCheck", 110, 145);
  ctx.fillStyle = "#14211e"; ctx.font = "800 42px Arial"; ctx.fillText(`${current.data.detective.risk} · ${current.pct}%`, 110, 235);
  let y = 330;
  if (current.image) {
    const img = await new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = `data:${current.image.mimeType};base64,${current.image.data}`; });
    const s = Math.min(1020 / img.width, 380 / img.height);
    ctx.drawImage(img, 110 + (1020 - img.width * s) / 2, y, img.width * s, img.height * s);
    y += 430;
  }
  ctx.font = "400 32px Arial"; y = wrap(ctx, current.text || "Ảnh chụp màn hình", 110, y, 1020, 44, 4) + 35;
  ctx.font = "700 34px Arial"; ctx.fillText("Phân tích", 110, y);
  ctx.font = "400 32px Arial"; y = wrap(ctx, current.data.detective.summary, 110, y + 55, 1020, 44, 5) + 35;
  ctx.font = "700 34px Arial"; ctx.fillText("Ba việc nên làm", 110, y);
  ctx.font = "400 31px Arial"; y += 55;
  (current.data.detective.actions || []).forEach((a, i) => y = wrap(ctx, `${i + 1}. ${a}`, 110, y, 1020, 42, 2) + 18);
  const a = document.createElement("a");
  a.download = "scamcheck-a4.png"; a.href = c.toDataURL("image/png"); a.click();
}

function wrap(ctx, text, x, y, w, lineH, max = 5) {
  const words = String(text || "").split(/\s+/); let line = "", lines = [];
  for (const word of words) { const test = line ? line + " " + word : word; if (ctx.measureText(test).width > w && line) { lines.push(line); line = word; } else line = test; }
  if (line) lines.push(line);
  lines.slice(0, max).forEach((l, i) => ctx.fillText(l + (i === max - 1 && lines.length > max ? "..." : ""), x, y + i * lineH));
  return y + Math.min(lines.length, max) * lineH;
}

function setError(text) { errorBox.textContent = text; errorBox.hidden = !text; }
function updateCount() { $("#count").textContent = `${message.value.length.toLocaleString("vi-VN")} / 5.000`; }

$$("[data-page]").forEach(b => b.onclick = e => { e.preventDefault(); setPage(b.dataset.page); });
$$("[data-sample]").forEach(b => b.onclick = () => { clearImage(); message.value = b.dataset.sample; updateCount(); });
$("#analyze").onclick = analyze;
$("#remove-image").onclick = clearImage;
$("#clear-history").onclick = () => { history = []; localStorage.removeItem(HISTORY); renderHistory(); };
screenshot.onchange = selectImage;
message.oninput = updateCount;
$("#font-size")?.addEventListener("input", e => setFont(e.target.value, true));

setFont(localStorage.getItem(FONT) || 18);
renderHistory();
loadLibrary();
updateCount();
loadShare();
