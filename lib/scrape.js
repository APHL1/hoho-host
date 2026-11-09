// Récupération des infos d'un produit à partir d'un lien (titre, image, prix)
// + téléchargement sécurisé d'images distantes.

const dns = require("node:dns").promises;
const net = require("node:net");

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36";

class ScrapeError extends Error {}

// ---------- Sécurité : on refuse les adresses du réseau local ----------
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) || // CGNAT / Tailscale
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }
  const v = ip.toLowerCase();
  if (v.startsWith("::ffff:")) return isPrivateIp(v.slice(7));
  return v === "::" || v === "::1" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80");
}

async function assertPublic(hostname) {
  const host = hostname.replace(/^\[|\]$/g, "");
  if (/^(localhost|.*\.local|.*\.internal|.*\.lan|.*\.home\.arpa)$/i.test(host)) throw new ScrapeError("Adresse interdite");
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new ScrapeError("Adresse interdite");
}

async function safeFetch(url, { maxBytes, accept, allowError = false }) {
  let current = url;
  for (let hop = 0; hop < 5; hop++) {
    const u = new URL(current);
    if (!/^https?:$/.test(u.protocol)) throw new ScrapeError("Lien invalide");
    await assertPublic(u.hostname);
    const res = await fetch(u, {
      redirect: "manual",
      signal: AbortSignal.timeout(9000),
      headers: { "user-agent": UA, accept, "accept-language": "fr-FR,fr;q=0.9,en;q=0.6" },
    });
    if ([301, 302, 303, 307, 308].includes(res.status) && res.headers.get("location")) {
      current = new URL(res.headers.get("location"), u).href;
      continue;
    }
    if (!res.ok && !allowError) throw new ScrapeError(`Le site a répondu ${res.status}`);
    const chunks = [];
    let total = 0;
    for await (const chunk of res.body) {
      total += chunk.length;
      if (total > maxBytes) break;
      chunks.push(chunk);
    }
    return { res, buf: Buffer.concat(chunks), finalUrl: u.href };
  }
  throw new ScrapeError("Trop de redirections");
}

// ---------- Parsing HTML ----------
function decodeEntities(s) {
  return String(s || "")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&euro;/g, "€")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function metaMap(html) {
  const map = {};
  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    const attrs = {};
    for (const m of tag.matchAll(/([a-zA-Z:-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) attrs[m[1].toLowerCase()] = m[3] ?? m[4];
    const key = (attrs.property || attrs.name || attrs.itemprop || "").toLowerCase();
    if (key && attrs.content && !(key in map)) map[key] = decodeEntities(attrs.content);
  }
  return map;
}

function findProduct(node, depth = 0) {
  if (!node || depth > 6) return null;
  if (Array.isArray(node)) {
    for (const n of node) {
      const p = findProduct(n, depth + 1);
      if (p) return p;
    }
    return null;
  }
  if (typeof node !== "object") return null;
  const t = node["@type"];
  if (t === "Product" || (Array.isArray(t) && t.includes("Product"))) return node;
  return findProduct(node["@graph"], depth + 1) || findProduct(node.mainEntity, depth + 1);
}

function jsonLdProduct(html) {
  for (const m of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const p = findProduct(JSON.parse(m[1].trim()));
      if (p) return p;
    } catch {}
  }
  return null;
}

const firstImage = (img) =>
  !img ? null : typeof img === "string" ? img : Array.isArray(img) ? firstImage(img[0]) : img.url || img.contentUrl || null;

function formatPrice(amount, currency) {
  const n = Number(String(amount).replace(",", "."));
  if (!amount || !isFinite(n) || n <= 0) return null;
  try {
    return new Intl.NumberFormat("fr-FR", { style: "currency", currency: (currency || "EUR").toUpperCase() }).format(n);
  } catch {
    return `${n.toLocaleString("fr-FR")} €`;
  }
}

function parseProduct(html, finalUrl) {
  const meta = metaMap(html);
  const ld = jsonLdProduct(html);
  const offer = ld && (Array.isArray(ld.offers) ? ld.offers[0] : ld.offers);

  let titre =
    (ld && ld.name) ||
    (html.match(/id=["']productTitle["'][^>]*>([\s\S]*?)<\/span>/i) || [])[1] ||
    meta["og:title"] ||
    meta["twitter:title"] ||
    (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1];

  let image =
    (html.match(/data-old-hires=["'](https:[^"']+)["']/i) || [])[1] ||
    (html.match(/"hiRes":"(https:[^"]+)"/) || [])[1] ||
    meta["og:image"] ||
    meta["og:image:secure_url"] ||
    meta["twitter:image"] ||
    firstImage(ld && ld.image) ||
    (html.match(/id=["']landingImage["'][^>]*src=["'](https:[^"']+)["']/i) || [])[1];

  let prix =
    formatPrice(offer && (offer.price || offer.lowPrice), offer && offer.priceCurrency) ||
    formatPrice(meta["product:price:amount"] || meta["og:price:amount"], meta["product:price:currency"] || meta["og:price:currency"]) ||
    formatPrice(meta["price"], meta["pricecurrency"]);
  if (!prix) {
    const amz = (html.match(/class=["']a-offscreen["'][^>]*>([^<]{1,30})</) || [])[1];
    if (amz && /\d/.test(amz)) prix = decodeEntities(amz);
  }

  titre = titre ? decodeEntities(titre).replace(/\s*[|–-]\s*(Amazon\.[a-z.]+|Fnac|Darty|Boulanger|Cdiscount).*$/i, "").slice(0, 200) : null;
  if (titre && /^(amazon\.[a-z.]+|robot check|just a moment|access denied|attention required)/i.test(titre)) titre = null;
  if (image) {
    try { image = new URL(decodeEntities(image), finalUrl).href; } catch { image = null; }
  }
  return { titre, image, prix };
}

// ---------- Amazon (pages souvent bloquées par un captcha) ----------
const AMAZON_HOST = /(^|\.)(amazon\.[a-z.]+|amzn\.[a-z]+|a\.co)$/i;
const MARKET = { fr: ["FR", "eu"], de: ["DE", "eu"], "co.uk": ["GB", "eu"], it: ["IT", "eu"], es: ["ES", "eu"], com: ["US", "na"], ca: ["CA", "na"], be: ["BE", "eu"], nl: ["NL", "eu"] };

function amazonFallback(finalUrl) {
  let u;
  try { u = new URL(finalUrl); } catch { return null; }
  if (!/(^|\.)amazon\.[a-z.]+$/i.test(u.hostname)) return null;
  const asin = (u.pathname.match(/\/(?:dp|gp\/product|gp\/aw\/d|exec\/obidos\/ASIN)\/([A-Z0-9]{10})/i) || [])[1];
  if (!asin) return null;
  const tld = u.hostname.replace(/^.*?amazon\./i, "").toLowerCase();
  const [market, region] = MARKET[tld] || ["FR", "eu"];
  // Titre lisible depuis l'URL : /Casque-Sony-WH-1000XM5/dp/B09…
  const slug = (u.pathname.match(/^\/([^/]+)\/(?:dp|gp)\//) || [])[1];
  let titre = null;
  if (slug && !/^(dp|gp|-)$/i.test(slug)) {
    try { titre = decodeURIComponent(slug).replace(/-/g, " ").replace(/\s+/g, " ").trim(); } catch {}
    if (titre && titre.length < 4) titre = null;
  }
  const image = `https://ws-${region}.amazon-adsystem.com/widgets/q?_encoding=UTF8&ASIN=${asin}&Format=_SL500_&ID=AsinImage&MarketPlace=${market}&ServiceVersion=20070822&WS=1`;
  return { titre, image, prix: null, asin };
}

async function previewLink(url) {
  const isAmazon = AMAZON_HOST.test(new URL(url).hostname);
  const { res, buf, finalUrl } = await safeFetch(url, {
    maxBytes: 3 * 1024 * 1024,
    accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
    allowError: isAmazon,
  });
  const type = res.headers.get("content-type") || "";
  if (res.ok && type.startsWith("image/")) return { titre: null, image: finalUrl, prix: null };
  let out = { titre: null, image: null, prix: null };
  if (res.ok || isAmazon) {
    const charset = (type.match(/charset=([\w-]+)/i) || [])[1] || "utf-8";
    let html;
    try { html = new TextDecoder(charset).decode(buf); } catch { html = buf.toString("utf8"); }
    out = parseProduct(html, finalUrl);
  }
  // Amazon bloque souvent : on complète avec ce que l'URL finale nous apprend
  const amz = amazonFallback(finalUrl);
  if (amz) {
    out.titre = out.titre || amz.titre;
    out.image = out.image || amz.image;
  }
  if (!out.titre && !out.image && !out.prix) {
    if (!res.ok) throw new ScrapeError(`Le site a répondu ${res.status}`);
  }
  return out;
}

// ---------- Images ----------
function sniffImage(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg";
  if (buf.slice(0, 4).toString("hex") === "89504e47") return "png";
  if (buf.slice(0, 4).toString() === "RIFF" && buf.slice(8, 12).toString() === "WEBP") return "webp";
  if (buf.slice(0, 4).toString() === "GIF8") return "gif";
  if (buf.slice(4, 12).toString().includes("ftypavif")) return "avif";
  return null;
}

async function downloadImage(url) {
  const { buf } = await safeFetch(url, { maxBytes: 8 * 1024 * 1024, accept: "image/avif,image/webp,image/*,*/*;q=0.8" });
  if (buf.length >= 8 * 1024 * 1024) throw new ScrapeError("Image trop lourde");
  if (buf.length < 600) throw new ScrapeError("Image vide");
  const ext = sniffImage(buf);
  if (!ext) throw new ScrapeError("Ce n'est pas une image");
  return { buf, ext };
}

module.exports = { previewLink, downloadImage, sniffImage, ScrapeError, parseProduct, amazonFallback };
