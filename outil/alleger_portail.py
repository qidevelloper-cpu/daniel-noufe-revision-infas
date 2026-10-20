#!/usr/bin/env python3
"""
ALLÉGER LE PORTAIL RÉVISION INFAS
Transforme le fichier unique (version finale exportée) en dossier léger,
installable (PWA) et utilisable hors ligne. Version étudiants (lecture seule).

Usage :  python3 alleger_portail.py Revision_INFAS.html  dossier_sortie
Dépendance : Pillow  (pip install pillow)
"""
import sys, os, re, io, json, base64, shutil, hashlib
from PIL import Image, ImageDraw, ImageFont

SRC, OUT = sys.argv[1], sys.argv[2]
WEBP_Q = 72
s = open(SRC, encoding='utf-8').read()

# ---------- 1. repérer les blocs <script> de premier niveau ----------
tags, i = [], 0
rx = re.compile(r'<script([^>]*)>')
while True:
    m = rx.search(s, i)
    if not m: break
    e = s.find('</script>', m.end())
    idm = re.search(r'id="([^"]+)"', m.group(1))
    tags.append(dict(id=idm.group(1) if idm else '', a=m.group(1), b=m.end(), e=e))
    i = e + 9
T = {t['id']: s[t['b']:t['e']] for t in tags}
for need in ('app-data', 'app-js'):
    if need not in T: sys.exit('Bloc #%s introuvable : ce fichier n’est pas un portail compatible.' % need)

if os.path.exists(OUT): shutil.rmtree(OUT)
for d in ('img', 'apps', 'icons'): os.makedirs(os.path.join(OUT, d))

# ---------- 2. images -> fichiers WebP ----------
imgmap, inline_imgs, before, after = {}, [], 0, 0
for t in tags:
    if not t['id'].startswith('img-'): continue
    n, uri = t['id'][4:], T[t['id']]
    head, b64 = uri.split(',', 1)
    raw = base64.b64decode(b64)
    before += len(uri)
    if 'svg' in head:                      # petits SVG : on les garde dans la page
        inline_imgs.append((t['id'], uri)); continue
    im = Image.open(io.BytesIO(raw))
    if im.mode not in ('RGB', 'RGBA'): im = im.convert('RGBA' if 'A' in im.mode else 'RGB')
    buf = io.BytesIO(); im.save(buf, 'WEBP', quality=WEBP_Q, method=6)
    if buf.tell() < len(raw): data, ext = buf.getvalue(), 'webp'
    else: data, ext = raw, 'jpg'
    fn = 'img/%s.%s' % (n, ext)
    open(os.path.join(OUT, fn), 'wb').write(data)
    imgmap[n] = fn + '?v=' + hashlib.sha1(data).hexdigest()[:8]; after += len(data)

# ---------- 3. applis complètes -> un fichier chacune (chargé à l’ouverture) ----------
apps = []
for t in tags:
    if not t['id'].startswith('app-src-'): continue
    k = t['id'][8:]
    js = '(window.__APPSRC=window.__APPSRC||{})[%s]=%s;\n' % (json.dumps(k), json.dumps(T[t['id']], ensure_ascii=False))
    open(os.path.join(OUT, 'apps', k + '.js'), 'w', encoding='utf-8').write(js)
    apps.append(k)

# ---------- 4. données : noyau (questions + cartes) + un fichier par matière (cours + résumés) ----------
D = json.loads(T['app-data'])
os.makedirs(os.path.join(OUT, 'data'))
matf = {}
for mid in set(D.get('res', {})) | set(D.get('course', {})):
    x = {'res': D.get('res', {}).get(mid), 'course': D.get('course', {}).get(mid)}
    txt = json.dumps(x, ensure_ascii=False, separators=(',', ':')).replace('</', '<\\/')
    h = hashlib.sha1(txt.encode()).hexdigest()[:8]
    open(os.path.join(OUT, 'data', mid + '.js'), 'w', encoding='utf-8').write('__MATX(%s,%s);\n' % (json.dumps(mid), txt))
    matf[mid] = 'data/%s.js?v=%s' % (mid, h)
D['res'], D['course'] = {}, {}
core = json.dumps(D, ensure_ascii=False, separators=(',', ':')).replace('</', '<\\/')
open(os.path.join(OUT, 'data.js'), 'w', encoding='utf-8').write('window.__APPDATA=' + core + ';\n')

# ---------- 5. moteur : petites retouches ----------
js = T['app-js']
def patch(old, new, js):
    if old not in js: sys.exit('Retouche impossible (moteur modifié ?) : ' + old[:60])
    return js.replace(old, new, 1)
js = patch("const DATA0=JSON.parse($('#app-data').textContent);",
           "const DATA0=window.__APPDATA||JSON.parse($('#app-data').textContent);", js)
js = patch("function imgSrc(n){",
           "function imgSrc(n){const _f=(window.__IMGF||{})[n];if(_f&&!document.getElementById('img-'+n))return _f;", js)
js = patch("async function appSource(m){",
           "function loadAppFile(k){return new Promise(ok=>{const A=window.__APPSRC=window.__APPSRC||{};if(A[k]!=null)return ok(A[k]);const sc=document.createElement('script');sc.src='apps/'+encodeURIComponent(k)+'.js?v='+(window.__BUILD||'');sc.onload=()=>ok(A[k]!=null?A[k]:null);sc.onerror=()=>ok(null);document.head.appendChild(sc)})}\n"
           "async function appSource(m){{const _t=await loadAppFile(m.src);if(_t!=null)return unesc(_t)}", js)
XHELP = ("const XL={},XP={};function needX(mid){return!!(window.__MATF||{})[mid]&&!XL[mid]}"
 "function ensureX(mid){if(!needX(mid))return Promise.resolve();if(XP[mid])return XP[mid];"
 "return XP[mid]=new Promise(ok=>{const sc=document.createElement('script');sc.src=window.__MATF[mid];"
 "sc.onload=()=>{XL[mid]=1;ok()};sc.onerror=()=>{XL[mid]=1;delete XP[mid];ok()};document.head.appendChild(sc)})}"
 "window.__MATX=function(mid,x){XL[mid]=1;DATA0.res[mid]=x.res||{ch:[],comp:[]};DATA0.course[mid]=x.course||[];"
 "if(typeof DATA!=='undefined'&&DATA){DATA.res[mid]=DATA0.res[mid];DATA.course[mid]=DATA0.course[mid]}"
 "try{delete CAPS[mid]}catch(e){}};\n")
js = patch("function groups(){", XHELP + "function groups(){", js)
js = patch("function render(){", "function render(){if(ctx&&ctx.id&&needX(ctx.id)){ensureX(ctx.id).then(()=>render());return}", js)
js = patch("function readCourse(mid,c,qid){", "function readCourse(mid,c,qid){if(needX(mid))return ensureX(mid).then(()=>readCourse(mid,c,qid));", js)
js = patch("function imgCap(mid,n){", "function imgCap(mid,n){if(needX(mid)){ensureX(mid);return''}", js)
js = js.replace('<img src=', '<img loading="lazy" decoding="async" src=')

# ---------- 6. page d’accueil légère ----------
head = s[:s.find('</head>')]
head = re.sub(r'<style id="ed-css">.*?</style>', '', head, flags=re.S)   # pas d’éditeur pour les étudiants
title = re.search(r'<title>(.*?)</title>', head).group(1)
theme = (re.search(r'name="theme-color" content="([^"]+)"', head) or [None, '#0E3B33'])[1]
build = hashlib.sha1(s.encode()).hexdigest()[:10]
pwa = ('<link rel="manifest" href="manifest.json">\n<link rel="icon" href="icons/icon-192.png">\n'
       '<link rel="apple-touch-icon" href="icons/icon-192.png">\n<meta name="mobile-web-app-capable" content="yes">\n'
       '<meta name="apple-mobile-web-app-capable" content="yes">\n')
edits = T.get('app-edits', '{}')
html = (head + pwa + '</head>\n<body>\n'
        + '<script>window.__BUILD=%s;window.__IMGF=%s;window.__MATF=%s;</script>\n' % (json.dumps(build), json.dumps(imgmap), json.dumps(matf))
        + '<script src="data.js?v=%s"></script>\n' % build
        + '<script type="application/json" id="app-edits">' + edits + '</script>\n'
        + ''.join('<script type="text/plain" id="%s">%s</script>\n' % x for x in inline_imgs)
        + '<script id="app-js">' + js + '</script>\n'
        + "<script>if('serviceWorker' in navigator&&location.protocol.startsWith('http'))navigator.serviceWorker.register('sw.js');</script>\n"
        + '</body>\n</html>\n')
open(os.path.join(OUT, 'index.html'), 'w', encoding='utf-8').write(html)

# ---------- 7. installation + hors ligne ----------
json.dump({"name": title, "short_name": "Révision INFAS", "start_url": "./", "scope": "./",
           "display": "standalone", "background_color": "#F4F1EA", "theme_color": theme, "lang": "fr",
           "icons": [{"src": "icons/icon-192.png", "sizes": "192x192", "type": "image/png"},
                     {"src": "icons/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any maskable"}]},
          open(os.path.join(OUT, 'manifest.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)

def icon(sz):
    im = Image.new('RGB', (sz, sz), theme); d = ImageDraw.Draw(im)
    d.ellipse([sz*.55, -sz*.25, sz*1.25, sz*.45], fill='#17594C')
    try: f = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', int(sz*.36))
    except Exception: f = ImageFont.load_default()
    d.text((sz/2, sz*.47), 'RI', font=f, fill='white', anchor='mm')
    d.rounded_rectangle([sz*.3, sz*.7, sz*.7, sz*.74], radius=sz*.02, fill='#E8772E')
    im.save(os.path.join(OUT, 'icons', 'icon-%d.png' % sz))
icon(192); icon(512)

core = ['./', 'index.html', 'data.js?v=' + build, 'manifest.json', 'icons/icon-192.png', 'icons/icon-512.png']
sw = """const V='rev-infas-%s';
const CORE=%s;
self.addEventListener('install',e=>{e.waitUntil(caches.open(V).then(c=>c.addAll(CORE)).then(()=>self.skipWaiting()))});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==V).map(x=>caches.delete(x)))).then(()=>self.clients.claim()))});
self.addEventListener('fetch',e=>{const r=e.request;if(r.method!=='GET'||new URL(r.url).origin!==location.origin)return;
 if(r.mode==='navigate'){e.respondWith(fetch(r).then(x=>{const y=x.clone();caches.open(V).then(c=>c.put('index.html',y));return x}).catch(()=>caches.match('index.html')));return}
 e.respondWith(caches.match(r).then(h=>h||fetch(r).then(x=>{if(x.ok){const y=x.clone();caches.open(V).then(c=>c.put(r,y))}return x})))});
""" % (build, json.dumps(core))
open(os.path.join(OUT, 'sw.js'), 'w').write(sw)
open(os.path.join(OUT, '.nojekyll'), 'w').write('')

# ---------- bilan ----------
def size(p): return os.path.getsize(os.path.join(OUT, p))
tot = sum(os.path.getsize(os.path.join(r, f)) for r, _, fs in os.walk(OUT) for f in fs)
print('Fichier d’origine : %.1f Mo' % (len(s.encode()) / 1e6))
print('index.html        : %.2f Mo' % (size('index.html') / 1e6))
print('data.js (noyau)   : %.2f Mo' % (size('data.js') / 1e6))
print('Cours par matière : %s' % ', '.join('%s %.2f Mo' % (k, size('data/%s.js' % k) / 1e6) for k in matf))
print('Images            : %d fichiers, %.1f Mo -> %.1f Mo' % (len(imgmap), before / 1e6, after / 1e6))
print('Applis            : %s' % ', '.join(apps))
print('Total dossier     : %.1f Mo' % (tot / 1e6))
