// The website's few behaviors: the download buttons for this OS, copy buttons, hero film/console switcher,
// reveal on scroll, and the phones that play their chats. Nothing here is needed to read the page.

const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

// Point the download buttons at this computer's build, and name the other systems that have one too.
{
  const ua = navigator.userAgent;
  const os = /Windows/.test(ua)
    ? "windows"
    : /Mac/.test(ua) && !/iPhone|iPad/.test(ua) && navigator.maxTouchPoints < 2
      ? "mac"
      : /Linux|X11/.test(ua) && !/Android/.test(ua)
        ? "linux"
        : null;
  for (const button of document.querySelectorAll("[data-os-download]")) {
    // A phone or tablet runs no installer: send it to every download.
    button.href = os ? button.dataset[os] : "#download";
    button.dataset.os = os === "linux" || !os ? "any" : os;
    const name = os ? `${os[0].toUpperCase()}${os.slice(1)}` : "Any";
    button.querySelector("[data-label]").textContent = button.dataset[`label${name}`];
  }
  const also = document.querySelector("[data-also]");
  if (also && os) {
    const [a, b] = ["mac", "windows", "linux"].filter((o) => o !== os);
    also.textContent = also.dataset.pair.replace("{a}", also.dataset[a]).replace("{b}", also.dataset[b]);
  }
  if (os && os !== "mac") document.querySelector("[data-intel]")?.remove();
}

for (const copy of document.querySelectorAll("[data-copy]")) {
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(copy.dataset.copy);
      const label = copy.textContent;
      copy.textContent = copy.dataset.done;
      setTimeout(() => (copy.textContent = label), 1500);
    } catch {}
  });
}

// Product film: keep native controls tucked away over the poster until first play.
for (const frame of document.querySelectorAll("[data-film]")) {
  const video = frame.querySelector("video");
  const play = frame.querySelector(".film-play");
  if (!video || !play) continue;
  video.controls = false;
  const startFilm = () => {
    if (frame.classList.contains("is-playing")) return;
    frame.classList.add("is-playing");
    video.controls = true;
    video.play().catch(() => {});
  };
  play.addEventListener("click", (e) => {
    e.stopPropagation();
    startFilm();
  });
  frame.addEventListener("click", startFilm);
}

// Hero stage switcher: toggle between the 40s product film and the native console screenshot.
for (const stage of document.querySelectorAll("[data-hero-stage]")) {
  const tabs = [...stage.querySelectorAll("[data-hero-tab]")];
  const panels = [...stage.querySelectorAll("[data-hero-panel]")];
  const activate = (name) => {
    for (const tab of tabs) tab.setAttribute("aria-selected", String(tab.dataset.heroTab === name));
    for (const panel of panels) {
      const active = panel.dataset.heroPanel === name;
      panel.hidden = !active;
      if (!active) panel.querySelector("video")?.pause();
    }
  };
  tabs.forEach((tab, i) => {
    tab.addEventListener("click", () => activate(tab.dataset.heroTab));
    tab.addEventListener("keydown", (e) => {
      const step = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
      if (!step) return;
      e.preventDefault();
      const next = tabs[(i + step + tabs.length) % tabs.length];
      next.focus();
      activate(next.dataset.heroTab);
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Phones with a short conversation: messages appear in order (data-seq) once they're on screen,
// with the app's typing indicator before Alex's replies. A group of phones plays as one conversation.
async function playPhones(root) {
  const phones = root.matches(".phone") ? [root] : [...root.querySelectorAll(".phone")];
  const msgs = phones
    .flatMap((p) => [...p.querySelectorAll(".m[data-seq]")].map((m) => ({ m, p })))
    .sort((x, y) => x.m.dataset.seq - y.m.dataset.seq);
  for (const { m, p } of msgs) {
    if (reduced) {
      m.classList.add("shown");
      m.querySelector(".rx .chip")?.classList.add("on");
      continue;
    }
    const typing = m.hasAttribute("data-typing") && p.querySelector(".typing-text")?.textContent;
    if (typing) {
      const label = p.querySelector(".im-sub") ?? p.querySelector(".im-title");
      const was = label.textContent;
      await sleep(400);
      label.textContent = typing;
      label.classList.add("is-typing");
      await sleep(1300);
      label.textContent = was;
      label.classList.remove("is-typing");
    } else await sleep(700);
    m.classList.add("shown");
    const chip = m.querySelector(".rx .chip");
    if (chip) {
      await sleep(500);
      chip.classList.add("pop", "on");
    }
    await sleep(500);
  }
}

const seen = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      seen.unobserve(entry.target);
      if (entry.target.matches("[data-seq-group], .phone-static")) playPhones(entry.target);
      else entry.target.classList.add("in");
    }
  },
  { rootMargin: "0px 0px -8% 0px" },
);
for (const el of document.querySelectorAll(".reveal, [data-seq-group], .phone-static:not([data-seq-group] .phone)"))
  seen.observe(el);
