/* Migration des progressions vers ProgressionUnifiee v1 (modèle validé le 04/11).
 *
 * Exécution prévue : dans le navigateur de l'étudiant, au premier lancement de l'application unifiée.
 * Fonctionne aussi sous Node (tests) avec un stockage simulé : { getItem(k), setItem(k, v) }.
 *
 * Garanties :
 *  - les 21 clés existantes (20 applis + portail) sont LUES, jamais modifiées ni supprimées ;
 *  - leur contenu d'origine est conservé octet pour octet (applis[p].brut, portail.brut) ;
 *  - le résultat est écrit dans UNE nouvelle clé (ri_progression_v1), puis relu et vérifié ;
 *  - la fusion est recalculée entièrement depuis les sources à chaque exécution (jamais ajoutée au résultat
 *    précédent) : relancée avec les mêmes sources, elle ne double rien et n'écrit rien ;
 *  - une clé de progression sans correspondance connue n'est PAS fusionnée : elle reste dans brut et est signalée.
 *
 * Règles de fusion par question (Question.id) :
 *  - vus et justes : addition des sources (portail + appli : tentatives distinctes) ; un nombre de bonnes réponses
 *    inconnu dans une source n'est pas inventé (la source est marquée « incomplet ») ;
 *  - dernier : tentative datée la plus récente ; sans date d'un côté, la valeur datée l'emporte ; sans aucune date
 *    et plusieurs sources : non tranché, signalé ;
 *  - specifique : champs propres à l'appli (ex. CN streak, nextReviewAt ; Pharmaco niveau de maîtrise), recopiés.
 */
(function (racine, fabrique) {
  if (typeof module === 'object' && module.exports) module.exports = fabrique();
  else racine.RIMigrationProgression = fabrique();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var CLE_SORTIE = 'ri_progression_v1';
  var CLE_PORTAIL = 'revInfas_progress_v1';

  /* Où chaque appli range ses résultats par question (relevé dans le code des 20 applis le 04/11).
     chemin : propriété de l'état qui contient la table question → résultat ('' = la racine ; null = aucun suivi
     par question, seul le contenu brut est conservé). */
  var APPLIS = [
    {prefixe: 'sonu', cle: 'sonu_infas_noufe_v1', chemin: 'last'},
    {prefixe: 'gyneco', cle: 'gyneco_l2_ide_noufe_v1', chemin: 'qs'},
    {prefixe: 'vih', cle: 'vih_l2_infas_v1', chemin: 'q'},
    {prefixe: 'pathotrop', cle: 'pathotrop_v1', chemin: 'ans'},          // clé = position q.i
    {prefixe: 'orl', cle: 'orl_infas_l3_v1', chemin: 'ans'},
    {prefixe: 'dermato', cle: 'dermato_l3_dn_v1', chemin: 'ans'},
    {prefixe: 'chir', cle: 'chirurgieInfas_progress_v1', chemin: 'qs'},
    {prefixe: 'endo', cle: 'endoOnco_L3_v1', chemin: null},              // totaux seulement, pas de suivi par question
    {prefixe: 'cn25', cle: 'infas_correction_nationale_2025_v1', chemin: ''},
    {prefixe: 'xmvkq53re', cle: 'pharmacoInfasProgress_v1', chemin: 'mastery'},
    {prefixe: 'xmvkq580o', cle: 'ssrPfL2SF_progress_v1', chemin: 'qs'},
    {prefixe: 'xmvkq5cba', cle: 'santeInfantileL1L2_progress_v1', chemin: 'qs'},
    {prefixe: 'xmvkq5gqn', cle: 'pedia_infas_v1', chemin: 'ans'},
    {prefixe: 'xmvkq5l1e', cle: 'medecine_ide2_infas_v1', chemin: 'ans'},
    {prefixe: 'xmvkq5pc5', cle: 'infas_digestif_portail_v1', chemin: 'qs'},
    {prefixe: 'xmvkq5tml', cle: 'snx_infas_v1', chemin: 'qs'},
    {prefixe: 'xmvkq5y0h', cle: 'osteoArthroPortal_v1', chemin: 'qs'},
    {prefixe: 'xmvkq62d4', cle: 'cellmus_infas_l1_v1', chemin: 'ans'},
    {prefixe: 'xmvkq66ok', cle: 'sp360_noufe_v1', chemin: 'ans'},
    {prefixe: 'xmvm9jr75', cle: 'ophtalmoL3_progress_v1', chemin: 'qs'}
  ];

  /* ---------- empreinte (SHA-256 si disponible, sinon FNV-1a 64 bits) ---------- */
  function empreinte(texte) {
    if (texte == null) return Promise.resolve('absente');
    try {
      if (typeof require === 'function') return Promise.resolve(require('crypto').createHash('sha256').update(texte, 'utf8').digest('hex'));
    } catch (e) { /* navigateur */ }
    if (typeof crypto !== 'undefined' && crypto.subtle && typeof TextEncoder !== 'undefined')
      return crypto.subtle.digest('SHA-256', new TextEncoder().encode(texte)).then(function (b) {
        return Array.prototype.map.call(new Uint8Array(b), function (x) { return ('0' + x.toString(16)).slice(-2) }).join('');
      });
    var h1 = 0xcbf29ce4, h2 = 0x84222325;
    for (var i = 0; i < texte.length; i++) { h2 ^= texte.charCodeAt(i); var a = Math.imul(h2, 0x1b3), b = Math.imul(h1, 0x1b3) + Math.imul(h2, 0x100); h1 = b >>> 0; h2 = a >>> 0 }
    return Promise.resolve('fnv' + h1.toString(16) + h2.toString(16));
  }

  function lireJSON(texte) { if (texte == null) return null; try { return JSON.parse(texte) } catch (e) { return undefined } }
  function nombre(v) { return typeof v === 'number' && isFinite(v) ? v : undefined }
  function date(v) {
    if (typeof v === 'number' && isFinite(v)) return v;
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) { var t = Date.parse(v.length === 10 ? v + 'T12:00:00Z' : v); return isFinite(t) ? t : undefined }
    return undefined;
  }
  function sans(obj, cles) { var r = {}; Object.keys(obj || {}).forEach(function (k) { if (cles.indexOf(k) < 0) r[k] = obj[k] }); return r }

  /* ---------- lecture d'UN enregistrement de progression, quel que soit le format de l'appli ----------
     Formats relevés : portail {n,k,l,t} · moteur {s,c,l} · {n,ok:bool,t} · {n,c,ok,d} · {c,w,last,t} · vih {n,ok:nb,last,t}
     · pédiatrie {n,good,bad,lastOk,t} · {n,ok:nb,last,d} · SNX {n,c,w,st,last} · SONU {ok,ts} · CN {seenCount,correctCount,
     lastCorrect,streak,status,lastSeenAt,nextReviewAt} · Pharmaco : niveau de maîtrise (nombre 0–4). */
  var CONSOMMES = ['n', 's', 'seenCount', 'k', 'c', 'w', 'good', 'bad', 'correctCount', 'ok', 'l', 'last', 'lastOk', 'lastCorrect', 'correct', 't', 'ts', 'd', 'lastSeenAt'];
  function lireEnregistrement(rec) {
    if (typeof rec === 'number') return {specifique: {maitrise: rec}, incomplet: ['vus', 'justes', 'dernier']};
    if (!rec || typeof rec !== 'object') return null;
    var vus = nombre(rec.n); if (vus === undefined) vus = nombre(rec.s); if (vus === undefined) vus = nombre(rec.seenCount);
    var justes = nombre(rec.k);
    if (justes === undefined) justes = nombre(rec.c);
    if (justes === undefined) justes = nombre(rec.good);
    if (justes === undefined) justes = nombre(rec.correctCount);
    if (justes === undefined && typeof rec.ok === 'number') justes = rec.ok;          // vih, médecine, digestif : ok = compteur
    if (vus === undefined && nombre(rec.c) !== undefined && nombre(rec.w) !== undefined) vus = rec.c + rec.w;
    if (vus === undefined && nombre(rec.good) !== undefined && nombre(rec.bad) !== undefined) vus = rec.good + rec.bad;
    var ok;
    if (rec.l === 0 || rec.l === 1) ok = rec.l === 1;
    else if (typeof rec.last === 'boolean' || rec.last === 0 || rec.last === 1) ok = !!rec.last;
    else if (typeof rec.lastOk === 'boolean') ok = rec.lastOk;
    else if (typeof rec.lastCorrect === 'boolean') ok = rec.lastCorrect;
    else if (typeof rec.ok === 'boolean') ok = rec.ok;
    else if (typeof rec.correct === 'boolean') ok = rec.correct;
    var t = date(rec.t); if (t === undefined) t = date(rec.ts); if (t === undefined) t = date(rec.lastSeenAt); if (t === undefined) t = date(rec.d);
    var incomplet = [];
    if (vus === undefined && ok !== undefined) { vus = 1; incomplet.push('vus (au moins 1 : seule la dernière réponse est connue)') }
    if (justes === undefined) incomplet.push('justes');
    var r = {vus: vus, justes: justes, ok: ok, t: t, specifique: sans(rec, CONSOMMES), incomplet: incomplet};
    if (!Object.keys(r.specifique).length) delete r.specifique;
    return r;
  }

  /* ---------- correspondances clé d'origine → Question.id, à partir de la banque unifiée ----------
     portail : origine.idPortailHerite (« vih.6 ») ; appli : origine.cleProgression si présent, sinon idOrigine pour les
     applis lues dans leur format natif (vih, chir, cn25), dont la progression est rangée par cet identifiant. */
  var NATIVES = {vih: 1, chir: 1, cn25: 1};
  function correspondancesDepuisBanque(questions) {
    var c = {portail: {}, applis: {}};
    (questions || []).forEach(function (q) {
      var o = q.origine || {};
      if (o.idPortailHerite) c.portail[o.idPortailHerite] = q.id;
      var cle = o.cleProgression != null ? String(o.cleProgression) : (NATIVES[o.app] && q.id.indexOf(o.app + '_q_') === 0 ? String(o.idOrigine) : null);
      if (cle != null) (c.applis[o.app] = c.applis[o.app] || {})[cle] = q.id;
    });
    return c;
  }

  /* ---------- fusion (pure : ne lit que les textes fournis) ---------- */
  function fusionner(textes, corresp, applis) {
    var res = {format: 'ri-progression', version: 1, eleve: {}, questions: {}, applis: {}, portail: null,
               migration: {anomalies: []}};
    var anomalies = res.migration.anomalies;
    function ajouter(uid, origine, cle, rec) {
      var lu = lireEnregistrement(rec);
      if (!lu) { anomalies.push(origine + ' : enregistrement illisible pour « ' + cle + ' »'); return }
      var e = res.questions[uid] || (res.questions[uid] = {vus: 0, justes: 0, sources: []});
      if (lu.vus !== undefined) e.vus += lu.vus;
      if (lu.justes !== undefined) e.justes += lu.justes;
      if (lu.specifique) e.specifique = Object.assign(e.specifique || {}, lu.specifique);
      e.sources.push({origine: origine, cle: cle, valeur: rec, incomplet: lu.incomplet.length ? lu.incomplet : undefined});
      if (lu.ok !== undefined) (e._candidats = e._candidats || []).push({ok: lu.ok, t: lu.t, source: origine});
    }
    function lireSource(origine, cle, chemin, table) {
      var brut = textes[cle];
      var etat = lireJSON(brut);
      var bloc = {cle: cle, brut: brut == null ? null : brut, extras: {}};
      if (brut == null) return bloc;
      if (etat === undefined || etat === null || typeof etat !== 'object') { anomalies.push(origine + ' : contenu illisible, conservé tel quel'); return bloc }
      if (chemin === null) { bloc.extras = etat; return bloc }
      var carte = chemin === '' ? etat : etat[chemin];
      bloc.extras = chemin === '' ? {} : sans(etat, [chemin]);
      var sansCorresp = 0;
      Object.keys(carte || {}).forEach(function (k) {
        var uid = table && table[k];
        if (!uid) { sansCorresp++; return }
        ajouter(uid, origine, k, carte[k]);
      });
      if (sansCorresp) anomalies.push(origine + ' : ' + sansCorresp + ' résultat(s) sans correspondance connue, non fusionné(s) (conservés dans brut)');
      return bloc;
    }
    res.portail = lireSource('portail', CLE_PORTAIL, 'qs', corresp.portail);
    (applis || APPLIS).forEach(function (a) { res.applis[a.prefixe] = lireSource(a.prefixe, a.cle, a.chemin, (corresp.applis || {})[a.prefixe]) });

    // dernier résultat : tentative datée la plus récente
    Object.keys(res.questions).forEach(function (uid) {
      var e = res.questions[uid], C = e._candidats || []; delete e._candidats;
      var dates = C.filter(function (c) { return c.t !== undefined });
      if (dates.length) { dates.sort(function (a, b) { return b.t - a.t }); e.dernier = {ok: dates[0].ok, t: dates[0].t, source: dates[0].source} }
      else if (C.length === 1) e.dernier = {ok: C[0].ok, source: C[0].source};
      else if (C.length > 1) anomalies.push(uid + ' : dernier résultat non tranché (aucune date, ' + C.length + ' sources)');
    });

    // identité : portail d'abord, sinon première appli qui en a une
    var p = lireJSON(textes[CLE_PORTAIL]) || {};
    res.eleve = {nom: p.name || undefined, avatar: p.avatar || undefined};
    Object.keys(res.applis).forEach(function (k) {
      var x = res.applis[k].extras || {};
      if (!res.eleve.nom && x.name) res.eleve.nom = x.name;
      if (!res.eleve.avatar && (x.av || x.ava || x.avatar)) res.eleve.avatar = x.av || x.ava || x.avatar;
    });
    return res;
  }

  /* ---------- exécution sur un stockage (localStorage ou simulé) ----------
     options : { stockage, questions (banque unifiée) | correspondances, maintenant, ecrire (défaut true) } */
  function migrer(options) {
    var st = options.stockage, applis = options.applis || APPLIS;
    var corresp = options.correspondances || correspondancesDepuisBanque(options.questions);
    var cles = [CLE_PORTAIL].concat(applis.map(function (a) { return a.cle }));
    var textes = {};
    cles.forEach(function (k) { textes[k] = st.getItem(k) });
    return Promise.all(cles.map(function (k) { return empreinte(textes[k]) })).then(function (hs) {
      var emp = {}; cles.forEach(function (k, i) { emp[k] = hs[i] });
      var prec = lireJSON(st.getItem(CLE_SORTIE));
      if (prec && prec.migration && JSON.stringify(prec.migration.empreintesSources) === JSON.stringify(emp))
        return {statut: 'inchange', progression: prec};          // mêmes sources : rien n'est recalculé ni réécrit
      var res = fusionner(textes, corresp, applis);
      res.migration.faiteLe = options.maintenant || Date.now();
      res.migration.empreintesSources = emp;
      if (options.ecrire === false) return {statut: 'simule', progression: res};
      // les sources n'ont pas bougé pendant la fusion ?
      var change = cles.filter(function (k) { return st.getItem(k) !== textes[k] });
      if (change.length) return {statut: 'refuse', raison: 'sources modifiées pendant la fusion : ' + change.join(', '), progression: res};
      var texte = JSON.stringify(res);
      try { st.setItem(CLE_SORTIE, texte) } catch (e) { return {statut: 'refuse', raison: 'écriture impossible (' + e.name + ')', progression: res} }
      if (st.getItem(CLE_SORTIE) !== texte) return {statut: 'refuse', raison: 'relecture différente après écriture', progression: res};
      return {statut: prec ? 'recalcule' : 'cree', progression: res};
    });
  }

  return {CLE_SORTIE: CLE_SORTIE, CLE_PORTAIL: CLE_PORTAIL, APPLIS: APPLIS, lireEnregistrement: lireEnregistrement,
          correspondancesDepuisBanque: correspondancesDepuisBanque, fusionner: fusionner, migrer: migrer};
});
