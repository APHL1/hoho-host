(() => {
  "use strict";

  // ================================================================
  // Utilitaires
  // ================================================================
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const app = $("#app");
  const state = { me: null, cats: [], timer: null, config: { titre: "Noël en famille", setup: false } };

  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  };

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const safeUrl = (u) => { try { const x = new URL(u); return /^https?:$/.test(x.protocol) ? x.href : ""; } catch { return ""; } };
  const imgSrc = (img) => (!img ? "" : /^https?:/i.test(img) ? safeUrl(img) : "/images/" + encodeURIComponent(img));
  const de = (name) => (/^[aeiouyhàâäéèêëîïôöûüœ]/i.test(String(name)) ? "d'" : "de ") + name;
  const plural = (n, w) => `${n} ${w}${n > 1 ? "s" : ""}`;

  const COLORS = ["#a3303c", "#2e5a46", "#c49a3c", "#3f5f8a", "#8a4f7d", "#b2643a", "#4d7a74", "#6b5a3e"];
  const color = (name) => { let h = 0; for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return COLORS[h % COLORS.length]; };
  const avatar = (name) => `<span class="avatar" style="background:${color(name)}">${esc(String(name).charAt(0).toUpperCase())}</span>`;

  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.remove("show"), 3000);
  }

  async function api(path, { method = "GET", body } = {}) {
    const r = await fetch(path, {
      method,
      headers: body !== undefined ? { "Content-Type": "application/json" } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: "same-origin",
    });
    let j = {};
    try { j = await r.json(); } catch {}
    if (r.status === 401 && j.code === "AUTH") {
      state.me = null;
      render();
      throw new Error(j.erreur);
    }
    if (!r.ok) throw Object.assign(new Error(j.erreur || "Oups, une erreur est survenue"), { status: r.status, data: j });
    return j;
  }

  // ================================================================
  // Modales
  // ================================================================
  function modal(html, { wide = false, onMount } = {}) {
    const ov = document.createElement("div");
    ov.className = "overlay";
    ov.innerHTML = `<div class="modal ${wide ? "wide" : ""}" role="dialog" aria-modal="true">${html}</div>`;
    document.body.appendChild(ov);
    document.body.classList.add("noscroll");
    const onKey = (e) => { if (e.key === "Escape") close(); };
    function close() {
      ov.remove();
      if (!$(".overlay")) document.body.classList.remove("noscroll");
      document.removeEventListener("keydown", onKey);
    }
    document.addEventListener("keydown", onKey);
    ov.addEventListener("mousedown", (e) => { if (e.target === ov) close(); });
    $$("[data-close]", ov).forEach((b) => b.addEventListener("click", close));
    const box = $(".modal", ov);
    onMount && onMount(box, close);
    const first = $("input:not([type=hidden]):not([type=file]):not([type=checkbox]), textarea", box);
    if (first && window.matchMedia("(min-width: 561px)").matches) setTimeout(() => first.focus(), 30);
    return close;
  }

  function confirmBox({ titre, texte, ok = "Confirmer", danger = false }) {
    return new Promise((resolve) => {
      let done = false;
      const close = modal(`
        <h3>${esc(titre)}</h3>
        <p class="lead">${texte}</p>
        <div class="foot">
          <button class="btn btn-line" data-close>Annuler</button>
          <button class="btn ${danger ? "btn-primary" : "btn-pine"}" data-ok>${esc(ok)}</button>
        </div>`, {
        onMount(box) {
          $("[data-ok]", box).onclick = () => { done = true; resolve(true); close(); };
          $$("[data-close]", box).forEach((b) => b.addEventListener("click", () => !done && resolve(false)));
        },
      });
    });
  }

  // ================================================================
  // Connexion
  // ================================================================
  // ================================================================
  // Assistant de premier démarrage
  // ================================================================
  function viewSetup() {
    stopPolling();
    app.innerHTML = `
      <div class="login-page">
        <div class="login-card setup-card">
          <img class="setup-logo" src="/icon-192.png" alt="">
          <p class="kicker">Bienvenue sur HoHoHost</p>
          <h1>On installe tout ça</h1>
          <p class="lead">Trois infos et ta famille peut commencer ses listes. Tu seras l'admin : c'est toi qui ajouteras les membres.</p>
          <form id="sf" novalidate>
            <div class="field"><label for="st">Nom du site</label><input class="input" id="st" maxlength="60" value="Noël en famille" required>
              <div class="status-line">Ex. « Noël chez les Martin ». Modifiable plus tard.</div></div>
            <div class="row2">
              <div class="field"><label for="sp">Ton prénom</label><input class="input" id="sp" autocomplete="given-name" maxlength="40" required></div>
              <div class="field"><label for="sn">Ton nom</label><input class="input" id="sn" autocomplete="family-name" maxlength="60" required></div>
            </div>
            <div class="row2">
              <div class="field"><label for="c1">Ton code (6 chiffres)</label><input class="input pin" id="c1" type="password" inputmode="numeric" maxlength="6" autocomplete="new-password"></div>
              <div class="field"><label for="c2">Confirme</label><input class="input pin" id="c2" type="password" inputmode="numeric" maxlength="6" autocomplete="new-password"></div>
            </div>
            ${state.config.setupCodeRequis ? `<div class="field"><label for="sc">Code d'installation <span class="hint">(variable SETUP_CODE)</span></label><input class="input" id="sc" autocomplete="off"></div>` : ""}
            <p class="err" id="se"></p>
            <button class="btn btn-primary btn-block" id="sgo">Créer mon espace famille</button>
          </form>
        </div>
      </div>`;
    $$(".pin").forEach((el) => el.addEventListener("input", () => (el.value = el.value.replace(/\D/g, "").slice(0, 6))));
    setTimeout(() => $("#sp").focus(), 30);
    $("#sf").onsubmit = async (ev) => {
      ev.preventDefault();
      const e = $("#se");
      const body = { titre: $("#st").value, prenom: $("#sp").value, nom: $("#sn").value, code: $("#c1").value, setupCode: $("#sc") ? $("#sc").value : "" };
      if (!body.prenom.trim() || !body.nom.trim()) return (e.textContent = "Indique ton prénom et ton nom");
      if (body.code.length !== 6) return (e.textContent = "Le code doit faire exactement 6 chiffres");
      if (/^(\d)\1{5}$/.test(body.code) || ["123456", "654321", "012345"].includes(body.code)) return (e.textContent = "Un peu trop facile à deviner 😉 Choisis-en un autre");
      if (body.code !== $("#c2").value) return (e.textContent = "Les deux codes ne sont pas identiques");
      $("#sgo").disabled = true;
      try {
        const r = await api("/api/setup", { method: "POST", body });
        state.me = r.moi;
        state.config = await api("/api/config");
        document.title = state.config.titre;
        location.hash = "#/admin";
        render();
        toast("C'est prêt ! Ajoute maintenant les membres de ta famille 🎄");
      } catch (err) {
        e.textContent = err.message;
        $("#sgo").disabled = false;
      }
    };
  }

  function viewLogin() {
    stopPolling();
    const saved = store.get("noel-ident", {});
    let ident = { prenom: saved.prenom || "", nom: saved.nom || "" };

    app.innerHTML = `
      <div class="login-page">
        <div class="login-card" id="lc"></div>
      </div>`;
    const card = $("#lc");

    function step1(msg = "") {
      card.innerHTML = `
        <p class="kicker">🎁 Listes de cadeaux</p>
        <h1>${esc(state.config.titre)}</h1>
        <p class="lead">Connecte-toi pour voir les envies de toute la famille.</p>
        <form id="f" novalidate>
          <div class="field"><label for="p">Prénom</label><input class="input" id="p" autocomplete="given-name" value="${esc(ident.prenom)}" required></div>
          <div class="field"><label for="n">Nom</label><input class="input" id="n" autocomplete="family-name" value="${esc(ident.nom)}" required></div>
          <p class="err" id="e">${esc(msg)}</p>
          <button class="btn btn-primary btn-block" id="go">Continuer</button>
        </form>`;
      const f = $("#f", card);
      setTimeout(() => (ident.prenom ? $("#n", card) : $("#p", card)).focus(), 30);
      f.onsubmit = async (ev) => {
        ev.preventDefault();
        ident = { prenom: $("#p", card).value.trim(), nom: $("#n", card).value.trim() };
        if (!ident.prenom || !ident.nom) return ($("#e", card).textContent = "Indique ton prénom et ton nom");
        $("#go", card).disabled = true;
        try {
          const r = await api("/api/identifier", { method: "POST", body: ident });
          store.set("noel-ident", ident);
          r.etape === "creer" ? stepCreate(r.prenom) : stepCode(r.prenom);
        } catch (e) {
          if (e.data && e.data.setup) { state.config.setup = true; return render(); }
          $("#e", card).textContent = e.message;
          $("#go", card).disabled = false;
        }
      };
    }

    const pinInput = (id, ac) =>
      `<input class="input pin" id="${id}" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="6" autocomplete="${ac}" required>`;
    const onlyDigits = (el) => el.addEventListener("input", () => { el.value = el.value.replace(/\D/g, "").slice(0, 6); });

    function stepCode(prenom) {
      card.innerHTML = `
        <p class="kicker">🎄 ${esc(state.config.titre)}</p>
        <h1>Coucou ${esc(prenom)} !</h1>
        <p class="lead">Entre ton code à 6 chiffres.</p>
        <p class="who"><button type="button" id="chg">Ce n'est pas moi</button></p>
        <form id="f" novalidate>
          <div class="field">${pinInput("c", "current-password")}</div>
          <p class="err" id="e"></p>
          <button class="btn btn-primary btn-block" id="go">Se connecter</button>
        </form>
        <p class="lead" style="margin:18px 0 0;font-size:13px">Code oublié ? Demande à l'admin de le réinitialiser.</p>`;
      const c = $("#c", card);
      onlyDigits(c);
      setTimeout(() => c.focus(), 30);
      $("#chg", card).onclick = () => step1();
      $("#f", card).onsubmit = async (ev) => {
        ev.preventDefault();
        if (c.value.length !== 6) return ($("#e", card).textContent = "Le code fait 6 chiffres");
        $("#go", card).disabled = true;
        try {
          const r = await api("/api/connexion", { method: "POST", body: { ...ident, code: c.value } });
          state.me = r.moi;
          location.hash = "#/";
          render();
        } catch (e) {
          if (e.data && e.data.etape === "creer") return stepCreate(prenom);
          $("#e", card).textContent = e.message;
          c.value = "";
          c.focus();
          $("#go", card).disabled = false;
        }
      };
    }

    function stepCreate(prenom) {
      card.innerHTML = `
        <p class="kicker">🎄 Première connexion</p>
        <h1>Bienvenue ${esc(prenom)} !</h1>
        <p class="lead">Choisis ton code secret à 6 chiffres. Il te servira à chaque connexion.</p>
        <p class="who"><button type="button" id="chg">Ce n'est pas moi</button></p>
        <form id="f" novalidate>
          <div class="field"><label for="c1">Ton code</label>${pinInput("c1", "new-password")}</div>
          <div class="field"><label for="c2">Confirme ton code</label>${pinInput("c2", "new-password")}</div>
          <p class="err" id="e"></p>
          <button class="btn btn-primary btn-block" id="go">C'est parti</button>
        </form>`;
      const c1 = $("#c1", card), c2 = $("#c2", card);
      onlyDigits(c1); onlyDigits(c2);
      c1.addEventListener("input", () => { if (c1.value.length === 6) c2.focus(); });
      setTimeout(() => c1.focus(), 30);
      $("#chg", card).onclick = () => step1();
      $("#f", card).onsubmit = async (ev) => {
        ev.preventDefault();
        const e = $("#e", card);
        if (c1.value.length !== 6) return (e.textContent = "Le code doit faire exactement 6 chiffres");
        if (/^(\d)\1{5}$/.test(c1.value) || ["123456", "654321", "012345"].includes(c1.value))
          return (e.textContent = "Un peu trop facile à deviner 😉 Choisis-en un autre");
        if (c1.value !== c2.value) return (e.textContent = "Les deux codes ne sont pas identiques");
        $("#go", card).disabled = true;
        try {
          const r = await api("/api/activer", { method: "POST", body: { ...ident, code: c1.value } });
          state.me = r.moi;
          location.hash = "#/";
          render();
          toast("Compte activé, bienvenue ! 🎄");
        } catch (err) {
          if (err.data && err.data.etape === "code") return stepCode(prenom);
          e.textContent = err.message;
          $("#go", card).disabled = false;
        }
      };
    }

    step1();
  }

  // ================================================================
  // Coquille (barre du haut)
  // ================================================================
  function shell(active, content) {
    const me = state.me;
    app.innerHTML = `
      <header class="top"><div class="top-in">
        <a class="brand" href="#/">🎄 ${esc(state.config.titre)}</a>
        <nav class="nav">
          <a href="#/" class="${active === "home" ? "on" : ""}"><span class="ico">🏠</span><span class="lbl">Famille</span></a>
          <a href="#/reservations" class="${active === "resa" ? "on" : ""}"><span class="ico">🎁</span><span class="lbl">Mes cadeaux à offrir</span></a>
          ${me.admin ? `<a href="#/admin" class="${active === "admin" ? "on" : ""}"><span class="ico">⚙️</span><span class="lbl">Admin</span></a>` : ""}
          <button id="acct" class="me" aria-label="Mon compte">${avatar(me.prenom).replace('class="avatar"', 'class="avatar" style="width:30px;height:30px;font-size:14px;background:' + color(me.prenom) + '"')}</button>
        </nav>
      </div></header>
      <main class="wrap" id="view">${content}</main>`;
    $("#acct").onclick = accountModal;
  }

  function accountModal() {
    modal(`
      <h3>${esc(state.me.prenom)} ${esc(state.me.nom)}</h3>
      <p class="lead">Ton compte</p>
      <form id="cf" novalidate>
        <div class="field"><label for="a">Code actuel</label><input class="input pin" id="a" type="password" inputmode="numeric" maxlength="6" autocomplete="current-password"></div>
        <div class="field"><label for="b">Nouveau code</label><input class="input pin" id="b" type="password" inputmode="numeric" maxlength="6" autocomplete="new-password"></div>
        <p class="err" id="ce"></p>
        <div class="foot" style="justify-content:space-between">
          <span><button type="button" class="btn btn-ghost" id="out">Se déconnecter</button> <a class="btn btn-ghost" href="#/aide" data-close>📱 Aide</a></span>
          <button class="btn btn-pine">Changer mon code</button>
        </div>
      </form>`, {
      onMount(box, close) {
        $$(".pin", box).forEach((el) => el.addEventListener("input", () => (el.value = el.value.replace(/\D/g, "").slice(0, 6))));
        $("#out", box).onclick = async () => {
          await api("/api/deconnexion", { method: "POST", body: {} }).catch(() => {});
          close();
          state.me = null;
          render();
        };
        $("#cf", box).onsubmit = async (ev) => {
          ev.preventDefault();
          const nouveau = $("#b", box).value;
          if (nouveau.length !== 6) return ($("#ce", box).textContent = "Le nouveau code doit faire 6 chiffres");
          try {
            await api("/api/moi/code", { method: "POST", body: { ancien: $("#a", box).value, nouveau } });
            close();
            toast("Code modifié ✓");
          } catch (e) { $("#ce", box).textContent = e.message; }
        };
      },
    });
  }

  // ================================================================
  // Accueil : la famille
  // ================================================================

  async function viewHome() {
    stopPolling();
    shell("home", `<div class="boot" style="height:40vh">🎄</div>`);
    const [{ listes }, secret] = await Promise.all([api("/api/listes"), api("/api/secret").catch(() => ({}))]);
    const cards = listes.map((l) => {
      const meta = l.moi
        ? `<strong>${plural(l.total, "idée")}</strong> dans ta liste`
        : l.total
          ? `<strong>${plural(l.total, "idée")}</strong> · ${l.disponibles} dispo${l.disponibles > 1 ? "s" : ""}`
          : "Pas encore d'idées";
      const badge = l.moi ? `<span class="badge">Ma liste</span>` : l.jeGere ? `<span class="badge gold">Je gère</span>` : "";
      const pills = [
        l.nouveautes ? `<span class="pill new">✨ ${plural(l.nouveautes, "nouveauté")}</span>` : "",
        l.questionsEnAttente ? `<span class="pill ask">❓ ${plural(l.questionsEnAttente, "question")}</span>` : "",
      ].join("");
      return `
        <a class="lcard ${l.moi ? "mine" : ""}" href="#/liste/${l.id}">
          ${badge}
          ${avatar(l.nom)}
          <div>
            <div class="name">${esc(l.nom)}</div>
            ${l.geree ? `<div class="meta">Liste gérée par ${esc(l.gerePar)}</div>` : ""}
          </div>
          <div class="meta">${meta}</div>
          ${pills ? `<div class="pills">${pills}</div>` : ""}
        </a>`;
    }).join("");

    const santa = secret && secret.actif && secret.participe ? `
      <section class="santa" id="santa">
        <div class="santa-ico">🎅</div>
        <div class="santa-txt">
          <div class="santa-k">Père Noël secret</div>
          <div class="santa-hide">Tu as été tiré au sort pour offrir un cadeau à quelqu'un… <button class="btn btn-sm btn-gold" id="reveal">Révéler</button></div>
          <div class="santa-show" hidden>Tu es le Père Noël secret ${/^[aeiouyhàâäéèêëîïôöûüœ]/i.test(secret.pour.nom) ? "d’" : "de "}<strong>${esc(secret.pour.nom)}</strong> 🤫${secret.budget ? ` · budget ${esc(secret.budget)}` : ""}
            ${secret.pour.listeId ? `<br><a class="btn btn-sm btn-gold" href="#/liste/${secret.pour.listeId}">Voir sa liste</a>` : ""}
            <button class="btn btn-sm btn-ghost-light" id="hide">Cacher</button></div>
        </div>
      </section>` : "";

    $("#view").innerHTML = `
      <div class="page-head"><div>
        <h1>Bonjour ${esc(state.me.prenom)} 👋</h1>
        <p class="sub">Clique sur quelqu'un pour voir ses envies.</p>
      </div></div>
      ${santa}
      <div class="fam">
        ${cards}
        <button class="lcard add" id="addList"><span class="plus">+</span><span>Créer une liste pour un proche<br><small>(enfant, grand-parent sans compte…)</small></span></button>
      </div>
      <p class="foot-help"><a href="#/aide">📱 Installer l'appli sur ton téléphone & astuces</a></p>`;

    if ($("#reveal")) {
      $("#reveal").onclick = () => { $(".santa-hide").hidden = true; $(".santa-show").hidden = false; };
      $("#hide").onclick = () => { $(".santa-hide").hidden = false; $(".santa-show").hidden = true; };
    }
    $("#addList").onclick = () => {
      modal(`
        <h3>Liste pour un proche</h3>
        <p class="lead">Pour quelqu'un qui n'a pas de compte : tu ajoutes ses idées à sa place, et tu verras ce que les autres réservent pour lui ou elle. Tu pourras ajouter d'autres gestionnaires (l'autre parent…).</p>
        <form id="lf"><div class="field"><label for="ln">Prénom</label><input class="input" id="ln" maxlength="40" required></div>
        <p class="err" id="le"></p>
        <div class="foot"><button type="button" class="btn btn-line" data-close>Annuler</button><button class="btn btn-pine">Créer la liste</button></div></form>`, {
        onMount(box, close) {
          $("#lf", box).onsubmit = async (ev) => {
            ev.preventDefault();
            try {
              const r = await api("/api/listes", { method: "POST", body: { nom: $("#ln", box).value } });
              close();
              location.hash = `#/liste/${r.id}`;
            } catch (e) { $("#le", box).textContent = e.message; }
          };
        },
      });
    };
  }

  // ================================================================
  // Une liste
  // ================================================================

  const filters = { cat: "toutes", dispo: "tout" };

  async function viewList(id) {
    shell("home", `<div class="boot" style="height:40vh">🎁</div>`);
    filters.cat = "toutes";
    filters.dispo = "tout";
    await loadList(id, true);
    startPolling(() => loadList(id, false));
  }

  async function loadList(id, first) {
    let d;
    try { d = await api(`/api/listes/${id}`); }
    catch (e) {
      if (first && $("#view")) $("#view").innerHTML = `<div class="empty"><span class="big">🤷</span>${esc(e.message)}<br><br><a href="#/">Retour à la famille</a></div>`;
      return null;
    }
    if (!$("#view")) return d;
    state.cats = d.categories;
    drawList(d, first);
    return d;
  }

  const fmtWhen = (t) => {
    const d = new Date(t), diff = Date.now() - t;
    if (diff < 60e3) return "à l'instant";
    if (diff < 3600e3) return `il y a ${Math.floor(diff / 60e3)} min`;
    if (diff < 86400e3 && d.getDate() === new Date().getDate()) return d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
    return d.toLocaleDateString("fr-FR", { day: "numeric", month: "short" }) + " " + d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  };

  function drawList(d, first) {
    const L = d.liste;
    const arts = d.articles;
    const showResa = !L.moi;
    const cats = [...new Set(arts.map((a) => a.categorie).filter(Boolean))].sort((a, b) => a.localeCompare(b, "fr"));
    if (filters.cat !== "toutes" && !cats.includes(filters.cat)) filters.cat = "toutes";

    const vis = arts.filter((a) =>
      (filters.cat === "toutes" || a.categorie === filters.cat) &&
      (!showResa || filters.dispo === "tout" || (filters.dispo === "dispo" ? !a.reservation : !!a.reservation))
    );
    const dispo = arts.filter((a) => !a.reservation).length;
    const pending = arts.reduce((n, a) => n + a.questions.filter((x) => !x.reponse).length, 0);

    const title = L.moi ? "Ma liste" : `La liste ${esc(de(L.nom))}`;
    const sub = L.moi
      ? "Ajoute tout ce qui te ferait plaisir. Tu ne verras pas ce qui est réservé, surprise oblige 🤫"
      : L.geree
        ? `Liste gérée par ${esc(L.gerePar)}. Clique sur « Je l'offre » pour éviter les doublons.`
        : "Clique sur « Je l'offre » pour que les autres sachent que c'est pris.";

    const html = `
      <a class="back" href="#/">← La famille</a>
      <div class="page-head">
        <div><h1>${title}</h1><p class="sub">${sub}</p></div>
        ${L.peutModifier ? `<div style="display:flex;gap:8px;flex-wrap:wrap">
          ${L.geree ? `<button class="btn btn-line" id="manageList">⋯ Gérer la liste</button>` : ""}
          <button class="btn btn-primary fab" id="addItem">＋ Ajouter un article</button></div>` : ""}
      </div>
      ${L.geree && L.peutModifier ? `<div class="banner pine">Tu gères cette liste : tu peux ajouter des idées <em>et</em> voir ce que les autres réservent.</div>` : ""}
      ${L.peutRepondre && pending ? `<div class="banner gold">❓ ${plural(pending, "question")} en attente de réponse sur ${L.moi ? "ta" : "cette"} liste. Les questions sont anonymes.</div>` : ""}
      ${arts.length ? `
      <div class="toolbar">
        <div class="stats">${showResa
          ? `<strong>${plural(arts.length, "idée")}</strong> · <strong>${dispo}</strong> encore disponible${dispo > 1 ? "s" : ""}`
          : `<strong>${plural(arts.length, "idée")}</strong>`}</div>
        <div class="chips">
          ${showResa ? ["tout:Tout", "dispo:Disponibles", "pris:Réservés"].map((x) => {
            const [k, v] = x.split(":");
            return `<button class="chip" data-dispo="${k}" aria-pressed="${filters.dispo === k}">${v}</button>`;
          }).join("") : ""}
        </div>
        ${cats.length > 1 ? `<div class="chips" style="width:100%">
          <button class="chip" data-cat="toutes" aria-pressed="${filters.cat === "toutes"}">Toutes catégories</button>
          ${cats.map((c) => `<button class="chip" data-cat="${esc(c)}" aria-pressed="${filters.cat === c}">${esc(c)}</button>`).join("")}
        </div>` : ""}
      </div>` : ""}
      <div class="grid" id="grid">
        ${vis.map((a) => itemCard(a, L)).join("") ||
          (arts.length
            ? `<div class="empty">Rien avec ces filtres.</div>`
            : L.peutModifier
              ? `<div class="empty"><span class="big">🎁</span>La liste est vide pour l'instant.<br>Clique sur « Ajouter un article » pour commencer !</div>`
              : `<div class="empty"><span class="big">🎁</span>${esc(L.nom)} n'a encore rien ajouté.</div>`)}
      </div>
      ${d.messages ? `
      <section class="chat" id="chat">
        <h2>💬 Entre nous</h2>
        <p class="chat-sub">${L.geree ? "Discussion entre les membres de la famille à propos de cette liste." : `${esc(L.nom)} ne voit pas cette discussion : idéal pour s'organiser (« on se met à deux ? »).`}</p>
        <div class="msgs">${d.messages.length ? d.messages.map((m) => `
          <div class="msg ${m.moi ? "me" : ""} ${m.nouveau ? "is-new" : ""}">
            <div class="msg-h"><strong>${esc(m.par)}</strong> <span>${fmtWhen(m.le)}</span>${m.moi || state.me.admin ? `<button class="msg-del" data-delmsg="${m.id}" aria-label="Supprimer">×</button>` : ""}</div>
            <div class="msg-t">${esc(m.texte)}</div>
          </div>`).join("") : `<p class="chat-empty">Aucun message pour l'instant.</p>`}</div>
        <form class="chat-form" id="chatf"><input class="input" id="chatin" maxlength="1000" placeholder="Écrire un message…" autocomplete="off"><button class="btn btn-pine">Envoyer</button></form>
      </section>` : ""}`;

    const view = $("#view");
    const sig = JSON.stringify({ ...d, articles: d.articles.map((a) => ({ ...a, nouveau: 0 })), messages: d.messages && d.messages.map((m) => ({ ...m, nouveau: 0 })) }) + JSON.stringify(filters);
    if (!first && view.dataset.sig === sig) return;
    view.dataset.sig = sig;
    view.innerHTML = html;
    const msgs = $(".msgs", view);
    if (msgs) msgs.scrollTop = msgs.scrollHeight;

    $$("[data-dispo]", view).forEach((b) => (b.onclick = () => { filters.dispo = b.dataset.dispo; drawList(d, true); }));
    $$("[data-cat]", view).forEach((b) => (b.onclick = () => { filters.cat = b.dataset.cat; drawList(d, true); }));
    const refresh = () => loadList(L.id, true);
    if ($("#addItem")) $("#addItem").onclick = () => itemForm(L, null, refresh);
    if ($("#manageList")) $("#manageList").onclick = () => manageList(L, refresh);

    if ($("#chatf")) {
      $("#chatf").onsubmit = async (ev) => {
        ev.preventDefault();
        const t = $("#chatin").value.trim();
        if (!t) return;
        try {
          await api(`/api/listes/${L.id}/messages`, { method: "POST", body: { texte: t } });
          await refresh();
          $("#chatin") && $("#chatin").focus();
        } catch (e) { toast(e.message); }
      };
      $("#chat").onclick = async (e) => {
        const b = e.target.closest("[data-delmsg]");
        if (!b) return;
        if (!(await confirmBox({ titre: "Supprimer ce message ?", texte: "", ok: "Supprimer", danger: true }))) return;
        await api(`/api/messages/${b.dataset.delmsg}`, { method: "DELETE" }).catch((err) => toast(err.message));
        refresh();
      };
    }

    $("#grid").onclick = async (e) => {
      const b = e.target.closest("[data-act]");
      if (!b) return;
      const art = arts.find((a) => a.id === Number(b.dataset.id));
      const act = b.dataset.act;
      try {
        if (act === "edit") return itemForm(L, art, refresh);
        if (act === "del") {
          const ok = await confirmBox({ titre: "Supprimer cet article ?", texte: `« ${esc(art.titre)} » sera retiré de la liste.`, ok: "Supprimer", danger: true });
          if (!ok) return;
          await api(`/api/articles/${art.id}`, { method: "DELETE" });
          toast("Article supprimé");
        }
        if (act === "resa") {
          const ok = await confirmBox({
            titre: "Tu offres ce cadeau ?",
            texte: `« ${esc(art.titre)} » apparaîtra comme réservé par toi pour le reste de la famille${L.geree ? "" : ` (mais pas pour ${esc(L.nom)}, évidemment 🤫)`}.`,
            ok: "🎁 Je l'offre",
          });
          if (!ok) return;
          await api(`/api/articles/${art.id}/reserver`, { method: "POST", body: {} });
          toast("C'est noté, merci ! Retrouve-le dans « Mes cadeaux à offrir » 🎄");
        }
        if (act === "unresa") {
          await api(`/api/articles/${art.id}/annuler`, { method: "POST", body: {} });
          toast("Réservation annulée");
        }
        if (act === "ask") return askQuestion(art, refresh);
        if (act === "answer") return answerQuestion(art.questions.find((x) => x.id === Number(b.dataset.q)), refresh);
        if (act === "delq") {
          if (!(await confirmBox({ titre: "Supprimer cette question ?", texte: "", ok: "Supprimer", danger: true }))) return;
          await api(`/api/questions/${b.dataset.q}`, { method: "DELETE" });
        }
        refresh();
      } catch (err) { toast(err.message); refresh(); }
    };
  }

  function itemCard(a, L) {
    const src = imgSrc(a.image);
    const lien = safeUrl(a.lien);
    const r = a.reservation;
    let resa = "";
    if (!L.moi) {
      if (!r) resa = `<button class="btn btn-primary" data-act="resa" data-id="${a.id}">🎁 Je l'offre</button>`;
      else if (r.moi) resa = `<div class="status mine">✓ Tu offres ce cadeau</div><button class="btn btn-ghost btn-sm" data-act="unresa" data-id="${a.id}">Annuler</button>`;
      else resa = `<div class="status other">🔒 Réservé par ${esc(r.par)}</div>`;
    }
    const cls = !L.moi && r ? (r.moi ? "mine" : "taken") : "";
    const qa = a.questions.length ? `<div class="qa">${a.questions.map((x) => `
      <div class="qa-item">
        <div class="qa-q">❓ ${esc(x.texte)} ${x.moi ? `<span class="qa-me">(ta question)</span>` : ""}
          ${x.moi || L.peutRepondre ? `<button class="qa-del" data-act="delq" data-id="${a.id}" data-q="${x.id}" aria-label="Supprimer">×</button>` : ""}</div>
        ${x.reponse
          ? `<div class="qa-r">💬 ${esc(x.reponse)}</div>`
          : L.peutRepondre
            ? `<button class="btn btn-sm btn-gold" data-act="answer" data-id="${a.id}" data-q="${x.id}">Répondre</button>`
            : `<div class="qa-wait">En attente de réponse…</div>`}
      </div>`).join("")}</div>` : "";
    return `
      <article class="card ${cls}">
        ${a.coupDeCoeur ? `<span class="fav">★ Coup de cœur</span>` : a.nouveau ? `<span class="fav new">✨ Nouveau</span>` : ""}
        ${L.peutModifier ? `<div class="edit-tools">
          <button class="btn-icon" data-act="edit" data-id="${a.id}" aria-label="Modifier" title="Modifier">✏️</button>
          <button class="btn-icon" data-act="del" data-id="${a.id}" aria-label="Supprimer" title="Supprimer">🗑</button></div>` : ""}
        <div class="media">${src ? `<img src="${esc(src)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : `<span class="ph">🎁</span>`}</div>
        <div class="body">
          <h2>${esc(a.titre)}${a.coupDeCoeur && a.nouveau ? ` <span class="pill new">✨ Nouveau</span>` : ""}</h2>
          ${a.prix || a.categorie ? `<div class="meta">
            ${a.prix ? `<span class="price">${esc(a.prix)}</span>` : ""}
            ${a.categorie ? `<span class="tag">${esc(a.categorie)}</span>` : ""}</div>` : ""}
          ${a.note ? `<p class="note">${esc(a.note)}</p>` : ""}
          ${qa}
          <div class="spacer"></div>
          <div class="actions">
            ${lien ? `<a class="btn btn-line" href="${esc(lien)}" target="_blank" rel="noopener noreferrer">Voir ↗</a>` : ""}
            ${resa}
          </div>
          ${!L.peutRepondre ? `<button class="ask-link" data-act="ask" data-id="${a.id}">❓ Poser une question${L.geree ? "" : " (anonyme)"}</button>` : ""}
        </div>
      </article>`;
  }

  function askQuestion(art, done) {
    modal(`
      <h3>Une question sur cet article ?</h3>
      <p class="lead">« ${esc(art.titre)} » — ta question est <strong>anonyme</strong> : personne ne saura que c'est toi. La réponse sera visible par toute la famille.</p>
      <form id="qf"><div class="field"><textarea class="input" id="qt" maxlength="300" rows="3" placeholder="Quelle taille ? Plutôt quelle couleur ?" required></textarea></div>
      <p class="err" id="qe"></p>
      <div class="foot"><button type="button" class="btn btn-line" data-close>Annuler</button><button class="btn btn-pine">Envoyer la question</button></div></form>`, {
      onMount(box, close) {
        $("#qf", box).onsubmit = async (ev) => {
          ev.preventDefault();
          try {
            await api(`/api/articles/${art.id}/questions`, { method: "POST", body: { texte: $("#qt", box).value } });
            close(); toast("Question envoyée (anonymement) ✓"); done();
          } catch (e) { $("#qe", box).textContent = e.message; }
        };
      },
    });
  }

  function answerQuestion(x, done) {
    modal(`
      <h3>Répondre</h3>
      <p class="lead">❓ ${esc(x.texte)}</p>
      <form id="rf"><div class="field"><textarea class="input" id="rt" maxlength="300" rows="3" required></textarea></div>
      <p class="err" id="re"></p>
      <div class="foot"><button type="button" class="btn btn-line" data-close>Annuler</button><button class="btn btn-pine">Envoyer</button></div></form>`, {
      onMount(box, close) {
        $("#rf", box).onsubmit = async (ev) => {
          ev.preventDefault();
          try {
            await api(`/api/questions/${x.id}/reponse`, { method: "POST", body: { reponse: $("#rt", box).value } });
            close(); toast("Réponse envoyée ✓"); done();
          } catch (e) { $("#re", box).textContent = e.message; }
        };
      },
    });
  }

  async function manageList(L, done) {
    const { membres } = await api("/api/membres");
    const ids = L.gestionnaires.map((g) => g.id);
    const others = membres.filter((m) => !ids.includes(m.id));
    modal(`
      <h3>Gérer la liste</h3>
      <form id="mf">
        <div class="field"><label for="mn">Prénom affiché</label>
          <div class="with-btn"><input class="input" id="mn" maxlength="40" value="${esc(L.nom)}"><button class="btn btn-pine">OK</button></div></div>
      </form>
      <div class="field"><label>Gestionnaires <span class="hint">(peuvent ajouter des idées et voient les réservations)</span></label>
        <div class="mgrs">${L.gestionnaires.map((g) => `<span class="mgr">${esc(g.nom)}${g.createur ? "" : ` <button data-rm="${g.id}" aria-label="Retirer">×</button>`}</span>`).join("")}</div>
        ${others.length ? `<div class="with-btn" style="margin-top:10px"><select class="input" id="addm">${others.map((m) => `<option value="${m.id}">${esc(m.nom)}</option>`).join("")}</select><button type="button" class="btn btn-line" id="addmb">＋ Ajouter</button></div>` : ""}
      </div>
      <p class="err" id="me"></p>
      <div class="foot" style="justify-content:space-between">
        <button type="button" class="btn btn-danger" id="mdel">Supprimer la liste</button>
        <button type="button" class="btn btn-line" data-close>Fermer</button>
      </div>`, {
      onMount(box, close) {
        const reopen = async () => { close(); const d = await loadList(L.id, true); if (d) manageList(d.liste, done); };
        $("#mf", box).onsubmit = async (ev) => {
          ev.preventDefault();
          try {
            await api(`/api/listes/${L.id}`, { method: "PATCH", body: { nom: $("#mn", box).value } });
            close(); done(); toast("Nom modifié ✓");
          } catch (e) { $("#me", box).textContent = e.message; }
        };
        if ($("#addmb", box)) $("#addmb", box).onclick = async () => {
          try { await api(`/api/listes/${L.id}/gestionnaires`, { method: "POST", body: { userId: Number($("#addm", box).value) } }); reopen(); }
          catch (e) { $("#me", box).textContent = e.message; }
        };
        $$("[data-rm]", box).forEach((b) => (b.onclick = async () => {
          try { await api(`/api/listes/${L.id}/gestionnaires/${b.dataset.rm}`, { method: "DELETE" }); reopen(); }
          catch (e) { $("#me", box).textContent = e.message; }
        }));
        $("#mdel", box).onclick = async () => {
          const ok = await confirmBox({ titre: `Supprimer la liste ${esc(de(L.nom))} ?`, texte: "Tous les articles et leurs réservations seront supprimés.", ok: "Supprimer", danger: true });
          if (!ok) return;
          await api(`/api/listes/${L.id}`, { method: "DELETE" });
          close();
          location.hash = "#/";
          toast("Liste supprimée");
        };
      },
    });
  }

  // ================================================================
  // Formulaire article (ajout / modification)
  // ================================================================
  async function resizeToDataUrl(file) {
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((res, rej) => {
        const i = new Image();
        i.onload = () => res(i);
        i.onerror = () => rej(new Error("Image illisible"));
        i.src = url;
      });
      const max = 1200;
      const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement("canvas");
      c.width = Math.round(img.naturalWidth * k);
      c.height = Math.round(img.naturalHeight * k);
      const ctx = c.getContext("2d");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(img, 0, 0, c.width, c.height);
      return c.toDataURL("image/jpeg", 0.85);
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  function itemForm(L, art, onSaved, prefill = {}) {
    const edit = !!art;
    let image = art ? art.image : null;

    modal(`
      <h3>${edit ? "Modifier l'article" : "Nouvel article"}</h3>
      <p class="lead">${edit ? "" : "Colle un lien : on essaie de remplir le reste tout seul."}</p>
      <form id="itf" novalidate>
        <div class="field">
          <label for="lien">Lien du produit <span class="hint">(facultatif)</span></label>
          <div class="with-btn">
            <input class="input" id="lien" type="text" inputmode="url" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="https://…" value="${esc(art?.lien || prefill.lien || "")}">
            <button type="button" class="btn btn-line" id="fetch" title="Récupérer les infos du lien">↻</button>
          </div>
          <div class="status-line" id="fst"></div>
        </div>
        <div class="field"><label for="titre">Nom de l'article</label><input class="input" id="titre" maxlength="200" value="${esc(art?.titre || "")}" required></div>
        <div class="field">
          <label>Image</label>
          <div class="img-pick">
            <div class="img-prev" id="iprev"></div>
            <div class="img-btns">
              <button type="button" class="btn btn-line btn-sm" id="ipick">📷 Choisir une photo</button>
              <button type="button" class="btn btn-ghost btn-sm" id="iclear">Retirer l'image</button>
              <span class="hint">Tu peux aussi coller une image (Ctrl/⌘+V)</span>
              <input type="file" id="ifile" accept="image/*" hidden>
            </div>
          </div>
        </div>
        <div class="row2">
          <div class="field"><label for="prix">Prix <span class="hint">(env.)</span></label><input class="input" id="prix" maxlength="40" placeholder="≈ 30 €" value="${esc(art?.prix || "")}"></div>
          <div class="field"><label for="cat">Catégorie</label><input class="input" id="cat" maxlength="40" list="cats" placeholder="Livres, Déco…" value="${esc(art?.categorie || "")}">
            <datalist id="cats">${state.cats.map((c) => `<option value="${esc(c)}">`).join("")}</datalist></div>
        </div>
        <div class="field"><label for="note">Précisions <span class="hint">(taille, couleur, modèle…)</span></label><textarea class="input" id="note" maxlength="300" rows="2" placeholder="Taille M, plutôt en noir">${esc(art?.note || "")}</textarea></div>
        <label class="toggle"><input type="checkbox" id="fav" ${art?.coupDeCoeur ? "checked" : ""}> ★ Coup de cœur (affiché en premier)</label>
        <p class="err" id="ie"></p>
        <div class="foot">
          <button type="button" class="btn btn-line" data-close>Annuler</button>
          <button class="btn btn-primary" id="isave">${edit ? "Enregistrer" : "Ajouter à la liste"}</button>
        </div>
      </form>`, {
      wide: true,
      onMount(box, close) {
        const f = (id) => $("#" + id, box);
        const st = f("fst");

        const drawImg = () => {
          const src = imgSrc(image);
          f("iprev").innerHTML = src ? `<img src="${esc(src)}" alt="" referrerpolicy="no-referrer">` : "🎁";
          f("iclear").hidden = !image;
        };
        drawImg();

        // Ce que le remplissage auto a mis : on peut le remplacer si le lien change
        let lastFetched = art?.lien || "";
        const auto = { titre: null, prix: null, image: null };
        let reqId = 0;
        const replaceable = (id, key) => !f(id).value.trim() || f(id).value === auto[key];

        // « Découvre ce produit sur Amazon https://amzn.eu/d/xyz » → on ne garde que le lien
        function cleanLinkField() {
          const raw = f("lien").value;
          const m = raw.match(/https?:\/\/[^\s<>"']+/i);
          if (!m) return { url: raw.trim(), texte: "" };
          const url = m[0].replace(/[).,;!?»]+$/, "");
          const texte = raw.replace(m[0], "").replace(/\s+/g, " ").trim();
          if (raw.trim() !== url) f("lien").value = url;
          return { url, texte };
        }

        async function fetchInfos(force) {
          const { url, texte } = cleanLinkField();
          if (!url || (!force && url === lastFetched)) return;
          lastFetched = url;
          const my = ++reqId;
          st.className = "status-line";
          st.innerHTML = `<span class="spin"></span> Je récupère les infos…`;
          try {
            const r = await api("/api/apercu-lien", { method: "POST", body: { url } });
            if (my !== reqId) return; // un lien plus récent a été collé entre-temps
            const titre = r.titre || (texte.length > 3 ? texte.replace(/^(découvre[sz]?|regarde[sz]?|voici)\s+/i, "").replace(/\s+sur\s+amazon.*$/i, "") : null);
            const got = [];
            if (titre && (force || replaceable("titre", "titre"))) { f("titre").value = auto.titre = titre; got.push("nom"); }
            if (force || replaceable("prix", "prix")) {
              f("prix").value = auto.prix = r.prix || "";
              if (r.prix) got.push("prix");
            }
            if (r.image && (force || !image || image === auto.image)) { image = auto.image = r.image; drawImg(); got.push("image"); }
            else if (!r.image && image && image === auto.image) { image = auto.image = null; drawImg(); }
            if (got.length) { st.className = "status-line ok"; st.textContent = `✓ Récupéré : ${got.join(", ")}. Vérifie et ajuste si besoin.`; }
            else { st.className = "status-line warn"; st.textContent = "Je n'ai rien trouvé sur cette page, complète à la main 🙂"; }
          } catch (e) {
            if (my !== reqId) return;
            st.className = "status-line warn";
            st.textContent = e.message;
          }
        }
        let debounce;
        f("lien").addEventListener("input", () => {
          clearTimeout(debounce);
          debounce = setTimeout(() => { if (/https?:\/\/\S+\.\S+/i.test(f("lien").value)) fetchInfos(false); }, 600);
        });
        f("lien").addEventListener("change", () => fetchInfos(false));
        f("fetch").onclick = () => fetchInfos(true);
        if (prefill.lien) { lastFetched = ""; fetchInfos(false); }

        async function useFile(file) {
          if (!file || !file.type.startsWith("image/")) return;
          f("iprev").innerHTML = `<span class="spin"></span>`;
          try {
            const data = await resizeToDataUrl(file);
            const r = await api("/api/image", { method: "POST", body: { data } });
            image = r.image;
          } catch (e) { toast(e.message); }
          drawImg();
        }
        f("ipick").onclick = () => f("ifile").click();
        f("ifile").onchange = () => useFile(f("ifile").files[0]);
        f("iclear").onclick = () => { image = null; drawImg(); };
        box.addEventListener("paste", (e) => {
          const file = [...(e.clipboardData?.files || [])].find((x) => x.type.startsWith("image/"));
          if (file) { e.preventDefault(); useFile(file); }
        });

        f("itf").onsubmit = async (ev) => {
          ev.preventDefault();
          const body = {
            titre: f("titre").value, lien: f("lien").value, prix: f("prix").value,
            categorie: f("cat").value, note: f("note").value, coupDeCoeur: f("fav").checked, image,
          };
          if (!body.titre.trim()) { f("ie").textContent = "Donne au moins un nom à l'article"; f("titre").focus(); return; }
          f("isave").disabled = true;
          f("isave").innerHTML = `<span class="spin"></span> Enregistrement…`;
          try {
            if (edit) await api(`/api/articles/${art.id}`, { method: "PUT", body });
            else await api(`/api/listes/${L.id}/articles`, { method: "POST", body });
            close();
            toast(edit ? "Article modifié ✓" : "Ajouté à la liste ✓");
            onSaved();
          } catch (e) {
            f("ie").textContent = e.message;
            f("isave").disabled = false;
            f("isave").textContent = edit ? "Enregistrer" : "Ajouter à la liste";
          }
        };
      },
    });
  }

  // ================================================================
  // Mes cadeaux à offrir
  // ================================================================

  const STATUTS = [
    { k: "reserve", l: "Réservé", i: "🔖" },
    { k: "achete", l: "Acheté", i: "🛍️" },
    { k: "emballe", l: "Emballé", i: "🎁" },
  ];
  const euro = (n) => n.toLocaleString("fr-FR", { style: "currency", currency: "EUR", maximumFractionDigits: n % 1 ? 2 : 0 });

  async function viewResa() {
    stopPolling();
    shell("resa", `<div class="boot" style="height:40vh">🎁</div>`);
    const { reservations } = await api("/api/reservations");
    const actifs = reservations.filter((r) => !r.retire);
    const groups = {};
    for (const r of reservations) (groups[r.liste.id] ||= { liste: r.liste, items: [] }).items.push(r);

    const total = actifs.reduce((s, r) => s + (r.prixNum || 0), 0);
    const sansPrix = actifs.filter((r) => !r.prixNum).length;
    const count = (k) => actifs.filter((r) => r.statut === k).length;
    const pct = (k) => (actifs.length ? (count(k) / actifs.length) * 100 : 0);

    $("#view").innerHTML = `
      <div class="page-head"><div>
        <h1>Mes cadeaux à offrir</h1>
        <p class="sub">${actifs.length ? "Coche au fur et à mesure : réservé → acheté → emballé." : ""}</p>
      </div></div>
      ${actifs.length ? `
      <section class="summary">
        <div class="sum-n"><span>Budget estimé</span><strong>${euro(total)}</strong>${sansPrix ? `<small>+ ${plural(sansPrix, "cadeau")} sans prix</small>` : ""}</div>
        <div class="sum-p">
          <div class="bar"><i class="b-emb" style="width:${pct("emballe")}%"></i><i class="b-ach" style="width:${pct("achete")}%"></i></div>
          <div class="sum-l">
            <span>🔖 ${count("reserve")} à acheter</span><span>🛍️ ${count("achete")} acheté${count("achete") > 1 ? "s" : ""}</span><span>🎁 ${count("emballe")} emballé${count("emballe") > 1 ? "s" : ""}</span>
          </div>
        </div>
      </section>` : ""}
      ${reservations.length ? Object.values(groups).map((g) => `
        <section class="group">
          <h2>${avatar(g.liste.nom)} <a href="#/liste/${g.liste.id}" style="color:inherit;text-decoration:none">${esc(g.liste.nom)}</a></h2>
          <div class="rlist">${g.items.map((r) => {
            const src = imgSrc(r.image);
            const lien = safeUrl(r.lien);
            return `
              <div class="ritem ${r.retire ? "gone" : ""} st-${r.statut}">
                <div class="th">${src ? `<img src="${esc(src)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : "🎁"}</div>
                <div class="txt">
                  <div class="t">${esc(r.titre)}</div>
                  <div class="s">${r.retire ? `⚠️ Retiré de la liste par ${esc(r.retirePar)} — pas besoin de l'acheter` : [r.prix, r.note].filter(Boolean).map(esc).join(" · ")}</div>
                </div>
                <div class="acts">
                  ${r.retire ? `<button class="btn btn-pine btn-sm" data-un="${r.id}">OK, compris</button>` : `
                    <div class="seg" role="group" aria-label="Avancement">${STATUTS.map((s) => `<button class="${r.statut === s.k ? "on" : ""}" data-st="${s.k}" data-id="${r.id}" title="${s.l}">${s.i}<span> ${s.l}</span></button>`).join("")}</div>
                    ${lien ? `<a class="btn btn-line btn-sm" href="${esc(lien)}" target="_blank" rel="noopener noreferrer">Voir ↗</a>` : ""}
                    <button class="btn btn-ghost btn-sm" data-un="${r.id}">Annuler</button>`}
                </div>
              </div>`;
          }).join("")}</div>
        </section>`).join("")
      : `<div class="empty"><span class="big">🎁</span>Tu n'as encore rien réservé.<br><a href="#/">Va voir les listes de la famille</a></div>`}`;

    $("#view").onclick = async (e) => {
      const st = e.target.closest("[data-st]");
      if (st) {
        try {
          await api(`/api/articles/${st.dataset.id}/statut`, { method: "POST", body: { statut: st.dataset.st } });
          const y = window.scrollY;
          await viewResa();
          window.scrollTo(0, y);
        } catch (err) { toast(err.message); }
        return;
      }
      const b = e.target.closest("[data-un]");
      if (!b) return;
      const r = reservations.find((x) => x.id === Number(b.dataset.un));
      if (!r.retire) {
        const ok = await confirmBox({ titre: "Annuler la réservation ?", texte: `« ${esc(r.titre)} » redeviendra disponible pour les autres.`, ok: "Annuler la réservation", danger: true });
        if (!ok) return;
      }
      try {
        await api(`/api/articles/${r.id}/annuler`, { method: "POST", body: {} });
        viewResa();
      } catch (err) { toast(err.message); }
    };
  }

  // ================================================================
  // Admin
  // ================================================================

  async function viewAdmin() {
    stopPolling();
    if (!state.me.admin) return (location.hash = "#/");
    shell("admin", `<div class="boot" style="height:40vh">⚙️</div>`);
    const [{ membres, saison }, secret] = await Promise.all([api("/api/admin/membres"), api("/api/admin/secret")]);
    const fmt = (t) => new Date(t).toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
    const nameOf = (id) => { const m = membres.find((x) => x.id === id); return m ? m.nomAffiche : "?"; };

    // État du formulaire Père Noël secret
    const sel = new Set(secret.actif ? secret.participants.map((p) => p.id) : membres.map((m) => m.id));
    let excl = secret.actif ? secret.exclusions.slice() : [];

    $("#view").innerHTML = `
      <div class="page-head"><div><h1>Admin</h1><p class="sub">Seules les personnes de cette liste peuvent se connecter.</p></div></div>

      <section class="panel">
        <h2>La famille <span style="color:var(--muted);font-size:16px">(${membres.length})</span></h2>
        <p>À sa première connexion, chaque personne tape son prénom + nom et choisit son code à 6 chiffres. Si un compte est « activé » alors que la personne ne s'est jamais connectée, réinitialise-le.</p>
        <div class="members">${membres.map((m) => `
          <div class="member">
            ${avatar(m.prenom)}
            <div class="txt">
              <div class="t">${esc(m.prenom)} ${esc(m.nom)} ${m.moi ? `<span style="color:var(--muted);font-weight:400">(toi)</span>` : ""}</div>
              <div class="s">
                ${m.admin ? `<span class="pill adm">Admin</span>` : ""}
                ${m.active ? `<span class="pill ok">Activé le ${fmt(m.activeLe)}</span>` : `<span class="pill wait">En attente de 1re connexion</span>`}
                ${m.bloque ? `<span class="pill lock">Bloqué 15 min</span>` : ""}
              </div>
            </div>
            ${m.moi ? "" : `<div class="acts">
              ${m.bloque ? `<button class="btn btn-line btn-sm" data-a="unlock" data-id="${m.id}">Débloquer</button>` : ""}
              ${m.active ? `<button class="btn btn-line btn-sm" data-a="reset" data-id="${m.id}">Réinitialiser le code</button>` : ""}
              <button class="btn btn-ghost btn-sm" data-a="admin" data-id="${m.id}">${m.admin ? "Retirer admin" : "Rendre admin"}</button>
              <button class="btn btn-danger btn-sm" data-a="del" data-id="${m.id}">Retirer</button>
            </div>`}
          </div>`).join("")}
        </div>
        <form class="add-member" id="am" novalidate>
          <input class="input" id="amp" placeholder="Prénom" maxlength="40" autocomplete="off">
          <input class="input" id="amn" placeholder="Nom" maxlength="60" autocomplete="off">
          <button class="btn btn-pine">＋ Ajouter</button>
        </form>
        <p class="err" id="ame"></p>
      </section>

      <section class="panel" id="santaAdmin">
        <h2>🎅 Père Noël secret</h2>
        ${secret.actif ? `
          <div class="banner pine">Tirage fait le ${fmt(secret.le)} avec ${plural(secret.participants.length, "participant")}${secret.budget ? ` · budget ${esc(secret.budget)}` : ""}. Chacun voit la personne qu'il a tirée sur sa page d'accueil. <strong>Toi non plus, tu ne vois que la tienne.</strong></div>` : `
          <p>Tire au sort qui offre un cadeau à qui. Personne (même pas toi) ne voit le tirage complet : chacun découvre uniquement la personne qu'il a tirée.</p>`}
        <div class="field"><label>Participants</label>
          <div class="checks" id="parts">${membres.map((m) => `<label class="check"><input type="checkbox" value="${m.id}" ${sel.has(m.id) ? "checked" : ""}> ${esc(m.nomAffiche)}</label>`).join("")}</div>
        </div>
        <div class="field"><label>Exclusions <span class="hint">(ces deux personnes ne peuvent pas se tirer, ex. un couple)</span></label>
          <div class="excls" id="excls"></div>
          <div class="excl-add">
            <select class="input" id="exa">${membres.map((m) => `<option value="${m.id}">${esc(m.nomAffiche)}</option>`).join("")}</select>
            <span>↔</span>
            <select class="input" id="exb">${membres.map((m, i) => `<option value="${m.id}" ${i === 1 ? "selected" : ""}>${esc(m.nomAffiche)}</option>`).join("")}</select>
            <button type="button" class="btn btn-line" id="exadd">＋</button>
          </div>
        </div>
        <div class="field" style="max-width:260px"><label for="sbud">Budget conseillé <span class="hint">(facultatif)</span></label><input class="input" id="sbud" maxlength="40" placeholder="≈ 30 €" value="${esc(secret.budget || "")}"></div>
        <p class="err" id="se"></p>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn btn-primary" id="sdraw">${secret.actif ? "🔁 Refaire le tirage" : "🎲 Lancer le tirage"}</button>
          ${secret.actif ? `<button class="btn btn-ghost" id="sdel">Annuler le tirage</button>` : ""}
        </div>
      </section>

      <section class="panel">
        <h2>Réglages</h2>
        <form class="with-btn" id="rg" style="max-width:520px">
          <input class="input" id="rgt" maxlength="60" value="${esc(state.config.titre)}" aria-label="Nom du site">
          <button class="btn btn-pine">Enregistrer</button>
        </form>
        <p class="status-line">Nom affiché en haut du site, sur l'écran de connexion et sous l'icône du téléphone.</p>
      </section>

      <section class="panel">
        <h2>Nouvelle saison</h2>
        <p>Après Noël : les cadeaux réservés (${saison} en ce moment) sont archivés et disparaissent des listes. Les idées non réservées restent, prêtes pour les anniversaires ou l'an prochain.</p>
        <button class="btn btn-primary" id="season" ${saison ? "" : "disabled"}>🎄 Lancer une nouvelle saison</button>
      </section>`;

    const drawExcl = () => {
      $("#excls").innerHTML = excl.length
        ? excl.map(([a, b], i) => `<span class="mgr">${esc(nameOf(a))} ↔ ${esc(nameOf(b))} <button data-rmx="${i}" aria-label="Retirer">×</button></span>`).join("")
        : `<span class="hint" style="color:var(--muted);font-size:14px">Aucune exclusion</span>`;
    };
    drawExcl();
    $("#excls").onclick = (e) => { const b = e.target.closest("[data-rmx]"); if (b) { excl.splice(Number(b.dataset.rmx), 1); drawExcl(); } };
    $("#exadd").onclick = () => {
      const a = Number($("#exa").value), b = Number($("#exb").value);
      if (a === b || excl.some(([x, y]) => (x === a && y === b) || (x === b && y === a))) return;
      excl.push([a, b]); drawExcl();
    };
    $("#sdraw").onclick = async () => {
      const participants = $$("#parts input:checked").map((i) => Number(i.value));
      if (secret.actif && !(await confirmBox({ titre: "Refaire le tirage ?", texte: "L'ancien tirage sera remplacé : préviens la famille que les attributions changent.", ok: "Refaire", danger: true }))) return;
      try {
        const r = await api("/api/admin/secret", { method: "POST", body: { participants, exclusions: excl, budget: $("#sbud").value } });
        toast(`Tirage fait pour ${r.participants} personnes 🎅`);
        viewAdmin();
      } catch (e) { $("#se").textContent = e.message; }
    };
    if ($("#sdel")) $("#sdel").onclick = async () => {
      if (!(await confirmBox({ titre: "Annuler le tirage ?", texte: "Plus personne ne verra son Père Noël secret.", ok: "Annuler le tirage", danger: true }))) return;
      await api("/api/admin/secret", { method: "DELETE" });
      viewAdmin();
    };

    $("#rg").onsubmit = async (ev) => {
      ev.preventDefault();
      try {
        const r = await api("/api/admin/reglages", { method: "PUT", body: { titre: $("#rgt").value } });
        state.config.titre = r.titre;
        document.title = r.titre;
        $(".brand").textContent = "🎄 " + r.titre;
        toast("Réglages enregistrés ✓");
      } catch (e) { toast(e.message); }
    };

    $("#am").onsubmit = async (ev) => {
      ev.preventDefault();
      try {
        await api("/api/admin/membres", { method: "POST", body: { prenom: $("#amp").value, nom: $("#amn").value } });
        toast(`${$("#amp").value.trim()} ajouté·e ✓`);
        viewAdmin();
      } catch (e) { $("#ame").textContent = e.message; }
    };

    $(".members").onclick = async (e) => {
      const b = e.target.closest("[data-a]");
      if (!b) return;
      const m = membres.find((x) => x.id === Number(b.dataset.id));
      const who = `${esc(m.prenom)} ${esc(m.nom)}`;
      try {
        if (b.dataset.a === "unlock") await api(`/api/admin/membres/${m.id}/debloquer`, { method: "POST", body: {} });
        if (b.dataset.a === "reset") {
          if (!(await confirmBox({ titre: "Réinitialiser le code ?", texte: `${who} choisira un nouveau code à sa prochaine connexion.`, ok: "Réinitialiser" }))) return;
          await api(`/api/admin/membres/${m.id}/reinitialiser`, { method: "POST", body: {} });
          toast("Code réinitialisé");
        }
        if (b.dataset.a === "admin") await api(`/api/admin/membres/${m.id}/admin`, { method: "POST", body: { admin: !m.admin } });
        if (b.dataset.a === "del") {
          if (!(await confirmBox({ titre: `Retirer ${who} ?`, texte: "Son compte, sa liste, les listes qu'il·elle gère et ses réservations seront supprimés. Irréversible.", ok: "Retirer", danger: true }))) return;
          await api(`/api/admin/membres/${m.id}`, { method: "DELETE" });
          toast("Membre retiré");
        }
        viewAdmin();
      } catch (err) { toast(err.message); }
    };

    $("#season").onclick = async () => {
      if (!(await confirmBox({ titre: "Nouvelle saison ?", texte: `${plural(saison, "cadeau réservé")} ser${saison > 1 ? "ont" : "a"} archivé${saison > 1 ? "s" : ""} et retiré${saison > 1 ? "s" : ""} des listes.`, ok: "Lancer", danger: true }))) return;
      const r = await api("/api/admin/nouvelle-saison", { method: "POST", body: {} });
      toast(`${plural(r.archives, "cadeau")} archivé${r.archives > 1 ? "s" : ""} 🎄`);
      viewAdmin();
    };
  }

  // ================================================================
  // Aide : installer l'appli, ajouter depuis le téléphone
  // ================================================================
  function viewAide() {
    stopPolling();
    const origin = location.origin;
    const ua = navigator.userAgent;
    const isIOS = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    const isAndroid = /Android/.test(ua);
    const shortcutUrl = `${origin}/partage?url=`;
    shell("aide", `
      <a class="back" href="#/">← La famille</a>
      <div class="page-head"><div><h1>Aide & astuces</h1><p class="sub">Installe le site comme une appli, et ajoute des idées en 2 secondes depuis n'importe quelle boutique.</p></div></div>

      <section class="panel ${isIOS ? "hl" : ""}">
        <h2>📱 Installer sur iPhone</h2>
        <ol class="steps">
          <li>Ouvre <strong>${esc(origin)}</strong> dans <strong>Safari</strong>.</li>
          <li>Touche le bouton <strong>Partager</strong> <span class="kbd">⬆︎</span> en bas de l'écran.</li>
          <li>Choisis <strong>« Sur l'écran d'accueil »</strong>, puis <strong>Ajouter</strong>.</li>
          <li>L'icône 🎁 <strong>Noël</strong> apparaît sur ton écran d'accueil : ouvre-la et connecte-toi une fois.</li>
        </ol>
      </section>

      <section class="panel ${isAndroid ? "hl" : ""}">
        <h2>🤖 Installer sur Android</h2>
        <ol class="steps">
          <li>Ouvre <strong>${esc(origin)}</strong> dans <strong>Chrome</strong>.</li>
          <li>Touche le menu <span class="kbd">⋮</span> en haut à droite.</li>
          <li>Choisis <strong>« Ajouter à l'écran d'accueil »</strong> (ou « Installer l'application »).</li>
          <li>Bonus : une fois installée, <strong>Noël</strong> apparaît dans le menu <strong>Partager</strong> de Chrome, Amazon… → l'article s'ajoute direct à ta liste.</li>
        </ol>
      </section>

      <section class="panel">
        <h2>⚡ Ajouter depuis Amazon & co sur iPhone</h2>
        <p>Une fois pour toutes, crée un petit raccourci (2 minutes). Ensuite : <em>Partager → Ajouter à ma liste de Noël</em> depuis n'importe quelle appli.</p>
        <ol class="steps">
          <li>Ouvre l'appli <strong>Raccourcis</strong> → <strong>＋</strong> (nouveau raccourci) → nomme-le <strong>« Ajouter à ma liste de Noël »</strong>.</li>
          <li>Touche <strong>ⓘ</strong> (ou le nom en haut) → active <strong>« Afficher dans la feuille de partage »</strong>, types acceptés : <strong>URL</strong> et <strong>Texte</strong>.</li>
          <li>Ajoute l'action <strong>« Ouvrir les URL »</strong> et tape dedans :
            <div class="copy"><code id="sc">${esc(shortcutUrl)}</code><button class="btn btn-sm btn-line" id="cp">Copier</button></div>
            puis, juste après, insère la variable <strong>« Entrée du raccourci »</strong>.</li>
          <li>C'est prêt ! Dans Amazon, Fnac… : <strong>Partager → Ajouter à ma liste de Noël</strong>. Le formulaire s'ouvre déjà rempli.</li>
        </ol>
      </section>

      <section class="panel">
        <h2>💻 Sur ordinateur</h2>
        <p>Glisse ce bouton dans ta barre de favoris. Sur une page produit, clique dessus : l'article s'ajoute à ta liste.</p>
        <p><a class="btn btn-primary" id="bm" href="#">🎁 + Ma liste de Noël</a> <span class="hint" style="color:var(--muted);font-size:13px">← à glisser dans les favoris</span></p>
      </section>
      <p class="app-version">HoHoHost ${esc(state.config.version || "")} · logiciel libre (AGPL-3.0) · <a href="https://github.com/APHL1/hoho-host" target="_blank" rel="noopener noreferrer">GitHub</a></p>`);
    // Lien javascript: construit par le DOM (non injecté en HTML)
    $("#bm").setAttribute("href", `javascript:location.href='${origin}/partage?url='+encodeURIComponent(location.href)`);
    $("#bm").onclick = (e) => { e.preventDefault(); toast("Glisse ce bouton dans ta barre de favoris 😉"); };
    $("#cp").onclick = async () => {
      try { await navigator.clipboard.writeText(shortcutUrl); toast("Copié ✓"); } catch { toast("Sélectionne le texte et copie-le"); }
    };
  }

  // ================================================================
  // Routeur
  // ================================================================
  function startPolling(fn) {
    stopPolling();
    state.timer = setInterval(() => {
      const a = document.activeElement;
      const typing = a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) && a.value;
      if (!document.hidden && !$(".overlay") && !typing) fn();
    }, 30000);
  }
  function stopPolling() { clearInterval(state.timer); }
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && state.me && /^#\/liste\//.test(location.hash) && !$(".overlay")) {
      loadList(location.hash.split("/")[2], false);
    }
  });

  // Lien partagé (menu Partager Android, raccourci iPhone, bouton favori)
  function pendingShare() {
    if (location.pathname !== "/partage") return null;
    // Raccourci iPhone : le lien arrive souvent non encodé (« ?url=https://…&th=1 ») → on prend tout
    const rawMatch = location.search.match(/^\?url=(https?:\/\/.*)$/i);
    let raw;
    if (rawMatch) {
      try { raw = decodeURIComponent(rawMatch[1]); } catch { raw = rawMatch[1]; }
    } else {
      const p = new URLSearchParams(location.search);
      raw = [p.get("url"), p.get("text"), p.get("title")].filter(Boolean).join(" ");
    }
    const m = raw.match(/https?:\/\/[^\s]+/);
    history.replaceState(null, "", "/" + location.hash);
    return m ? m[0] : null;
  }
  let shared = pendingShare();

  async function handleShare() {
    const url = shared;
    shared = null;
    const { listes } = await api("/api/listes");
    const mine = listes.find((l) => l.moi);
    if (!mine) return;
    location.hash = `#/liste/${mine.id}`;
    await render();
    const d = await api(`/api/listes/${mine.id}`);
    itemForm(d.liste, null, () => loadList(mine.id, true), { lien: url });
  }

  async function render() {
    $$(".overlay").forEach((o) => o.remove());
    document.body.classList.remove("noscroll");
    if (state.config.setup) return viewSetup();
    if (!state.me) return viewLogin();
    if (shared) return handleShare();
    const h = location.hash || "#/";
    window.scrollTo(0, 0);
    try {
      let m;
      if ((m = h.match(/^#\/liste\/(\d+)/))) return await viewList(m[1]);
      if (h === "#/reservations") return await viewResa();
      if (h === "#/admin") return await viewAdmin();
      if (h === "#/aide") return viewAide();
      return await viewHome();
    } catch (e) {
      if (state.me && $("#view")) $("#view").innerHTML = `<div class="empty"><span class="big">😕</span>${esc(e.message)}</div>`;
    }
  }

  window.addEventListener("hashchange", render);

  (async () => {
    try { state.config = await api("/api/config"); } catch {}
    try { state.me = (await api("/api/moi")).moi; } catch {}
    render();
  })();
})();
