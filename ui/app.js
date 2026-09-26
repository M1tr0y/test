const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
let api;

const LABELS = {
  rust_dir: "Rust", export_dir: "Папка моделей", ae_exe: "After Effects",
  premiere_exe: "Premiere Pro", blender_exe: "Blender",
};

// ------------------------------------------------------------------ helpers
function show(id) {
  $$(".screen").forEach(s => s.classList.toggle("shown", s.id === id));
}

function toast(text, err = false) {
  const t = document.createElement("div");
  t.className = "toast" + (err ? " err" : "");
  t.textContent = text;
  $("#toasts").append(t);
  setTimeout(() => { t.classList.add("out"); setTimeout(() => t.remove(), 400); }, err ? 7000 : 4000);
}

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function highlight(text, q) {
  const safe = escapeHtml(text);
  if (!q) return safe;
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return safe;
  return escapeHtml(text.slice(0, i)) + "<mark>" + escapeHtml(text.slice(i, i + q.length)) + "</mark>" + escapeHtml(text.slice(i + q.length));
}

// Current progress bar is whichever screen is active.
function activeProgress() {
  return $("#setup").classList.contains("shown") ? $("#setupProgress") : $("#progress");
}

// ------------------------------------------------------------------ called from Python
window.ui = {
  log(line) {
    const pre = $("#log");
    pre.textContent += line + "\n";
    if (pre.textContent.length > 200000) pre.textContent = pre.textContent.slice(-150000);
    pre.scrollTop = pre.scrollHeight;
  },
  progress(text, percent) {
    const p = activeProgress();
    p.classList.remove("hidden", "done", "fail");
    $(".bar", p).style.width = percent + "%";
    $(".label", p).textContent = text;
  },
  taskDone(name, ok, result) {
    const p = activeProgress();
    p.classList.add(ok ? "done" : "fail");
    if (!ok) $(".label", p).textContent = "Ошибка: " + result;
    setBusy(false);

    if (name === "setup") {
      if (ok) { toast("Установка завершена"); enterMain(result); }
      else toast("Не получилось установить: " + result, true);
    } else if (name === "scan") {
      if (ok) { $("#count").textContent = result; toast(`Найдено моделей: ${result}`); runSearch(); }
      else toast("Не удалось прочитать файлы игры: " + result, true);
    } else if (name === "send") {
      if (ok) toast("Готово! Файл: " + result);
      else { toast("Ошибка: " + result, true); $("#console").classList.add("open"); }
    }
  },
};

function setBusy(busy) {
  $$(".action, #rescan, #settings, #next, #back").forEach(b => (b.disabled = busy));
}

// ------------------------------------------------------------------ wizard
let step = 0;
const values = {};

function fillFields() {
  $$(".field").forEach(f => {
    const v = values[f.dataset.key] || "";
    $("input", f).value = v;
    $("input", f).placeholder = "не найдено — нажми «Обзор»";
    f.classList.toggle("ok", !!v);
  });
}

function goStep(n) {
  step = Math.max(0, Math.min(3, n));
  $$(".page").forEach(p => {
    const i = +p.dataset.page;
    p.classList.toggle("active", i === step);
    p.classList.toggle("left", i < step);
  });
  $$(".step-dot").forEach(d => {
    const i = +d.dataset.step;
    d.classList.toggle("active", i === step);
    d.classList.toggle("done", i < step);
  });
  $("#back").style.visibility = step === 0 ? "hidden" : "visible";
  $("#next").textContent = step === 3 ? "Установить" : "Далее";
  if (step === 3) {
    $("#summary").innerHTML = Object.entries(LABELS).map(([k, label]) =>
      `<li class="${values[k] ? "" : "missing"}"><b>${label}</b><span>${escapeHtml(values[k] || "не указано")}</span></li>`
    ).join("");
  }
}

async function openSetup() {
  Object.assign(values, await api.detect());
  fillFields();
  $("#setupProgress").classList.add("hidden");
  goStep(0);
  show("setup");
}

function initWizard() {
  $$(".field").forEach(f => {
    $("button", f).addEventListener("click", async e => {
      e.preventDefault();
      const picked = await api.browse(f.dataset.key, values[f.dataset.key] || "");
      if (picked) { values[f.dataset.key] = picked; fillFields(); }
    });
  });
  $("#back").addEventListener("click", () => goStep(step - 1));
  $("#next").addEventListener("click", async () => {
    if (step === 0 && !values.rust_dir) return toast("Укажи папку с игрой Rust", true);
    if (step < 3) return goStep(step + 1);
    setBusy(true);
    ui.progress("Начинаю установку…", 3);
    await api.finish_setup(values);
  });
}

// ------------------------------------------------------------------ main screen
let selected = null;
let searchTimer;

async function runSearch() {
  const q = $("#q").value;
  const res = await api.search(q);
  const list = $("#list");
  list.innerHTML = res.items.map((m, n) =>
    `<div class="item" data-idx="${m.idx}" style="animation-delay:${Math.min(n, 20) * 18}ms">
       <b>${highlight(m.name, q.trim())}</b><small>${escapeHtml(m.container || m.source || "")}</small>
     </div>`).join("");
  $("#listFoot").textContent = res.total > res.items.length
    ? `Показано ${res.items.length} из ${res.total} — уточни поиск`
    : `Найдено: ${res.total}`;
  list.scrollTop = 0;
  $$(".item", list).forEach(el => el.addEventListener("click", () => select(el, res.items.find(m => m.idx == el.dataset.idx))));
}

function select(el, model) {
  $$(".item.selected").forEach(i => i.classList.remove("selected"));
  el.classList.add("selected");
  selected = model;
  $("#empty").classList.add("hidden");
  const card = $("#card");
  card.classList.remove("hidden");
  card.style.animation = "none"; void card.offsetWidth; card.style.animation = "";  // replay entrance
  $("#mName").textContent = model.name;
  $("#mContainer").textContent = model.container || model.source || "";
  $("#progress").classList.add("hidden");
}

async function enterMain(state) {
  $("#count").textContent = state.model_count;
  show("main");
  if (!state.model_count) {
    toast("Первый раз читаю файлы игры — это займёт несколько минут");
    $("#card").classList.add("hidden");
    setBusy(true);
    ui.progress("Читаю файлы Rust…", 5);
    $("#console").classList.add("open");
    await api.scan();
  } else runSearch();
}

function initMain() {
  $("#q").addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 160); });
  $("#rescan").addEventListener("click", async () => { setBusy(true); $("#progress").classList.remove("hidden"); await api.scan(); });
  $("#settings").addEventListener("click", openSetup);
  $("#consoleToggle").addEventListener("click", () => $("#console").classList.toggle("open"));
  $$(".action").forEach(b => b.addEventListener("click", async () => {
    if (!selected) return;
    setBusy(true);
    ui.progress("Запускаю…", 3);
    await api.send(selected.idx, b.dataset.targets.split(","));
  }));
}

// ------------------------------------------------------------------ boot
window.addEventListener("pywebviewready", async () => {
  api = window.pywebview.api;
  initWizard();
  initMain();
  const state = await api.get_state();
  if (state.configured) enterMain(state);
  else openSetup();
});
