/* rastro.js — carimba de qual anúncio a pessoa veio, do clique até a Kiwify.
 *
 * Uma linha em qualquer landing:  <script src="/rastro.js" defer></script>
 * (nas landings que moram em outro site, copie este arquivo junto.)
 *
 * O que ele faz, em ordem:
 *   1. lê os parâmetros da URL (utm_*, ad_id, fbclid…)
 *   2. guarda por 30 dias — a pessoa clica no anúncio, some, volta depois
 *      direto pelo link, e sem isso a venda chegaria órfã
 *   3. carimba TODO link de checkout da Kiwify da página
 *   4. preenche os campos ocultos de qualquer formulário da página
 *
 * ── AS DECISÕES, PRA NINGUÉM DESFAZER SEM SABER ───────────────────────────
 *
 * ⚠️ O `ad_id` VAI NO `sck`. É um dos dois campos livres que a Kiwify devolve
 *    no webhook. Não usar `utm_campaign` como chave: o nome da campanha a Meta
 *    deixa trocar a qualquer hora e o histórico inteiro descasa em silêncio.
 *    O id não muda. O nome vai junto, mas só pra ela ler.
 *
 * ⚠️ VALE O ÚLTIMO CLIQUE PAGO, não o primeiro. Quem viu três anúncios e
 *    comprou depois do terceiro foi convencido pelo terceiro. O primeiro fica
 *    guardado em `primeiro` pra conferência, mas quem vai pro checkout é o
 *    último — e está escrito aqui porque é uma ESCOLHA, não uma verdade.
 *
 * ⚠️ NÃO INVENTA ORIGEM. Quem chega sem parâmetro nenhum vai pro checkout sem
 *    `sck`, e a venda aparece no painel como "sem anúncio". Carimbar
 *    "orgânico" por falta de dado faria verba ser realocada por um número que
 *    ninguém mediu.
 */
(function () {
  'use strict';

  var CHAVE = 'lala.rastro';
  var DIAS = 30;
  var CHECKOUT = /(^|\.)kiwify\.com\.br$/i;

  /* ⭐ O PING. Sem ele o funil só sabe quem COMPROU — as etapas de cima
   * ficariam em branco pra sempre, e funil com etapa em branco não mede.
   * Vai pro /api/visita, que conta UM arquivo por visitante (ver visita.mjs).
   * ⚠️ Endereço absoluto: a landing mora em outro domínio que o painel. */
  var PING = 'https://lailasalon-consultoria.netlify.app/api/visita';
  var CHAVE_VID = 'lala.vid';

  /* ⭐ UMA PÁGINA PODE *SER* A ORIGEM DE UM FUNIL.
   *
   * A aula não chega por link com `utm_` — ela É o começo. Então a própria
   * página declara de qual funil ela é a boca:
   *
   *   <script src="rastro.js" data-funil="aula" defer></script>
   *
   * Com isso, nesta página o rastro.js:
   *   1. conta quem ABRIU (evento `origem`)
   *   2. conta quem CLICOU no botão pra página de vendas (evento `clique`)
   *   3. CARIMBA sozinho todo link que vai pra landing — ela não precisa
   *      escrever `?utm_source=aula` à mão em lugar nenhum, e link escrito à
   *      mão é onde a medição morre.
   *
   * ⚠️ Carimbo automático só vale pros links da LANDING. Link de checkout
   *    direto continua sendo carimbado pelo caminho normal, com o rastro
   *    que a pessoa trouxe. */
  var LANDING = /(^|\.)lala-landing\.netlify\.app$/i;
  function funilDaPagina() {
    var s = document.currentScript;
    if (!s) {
      var todos = document.getElementsByTagName('script');
      for (var i = 0; i < todos.length; i++) {
        if (todos[i].getAttribute && todos[i].getAttribute('data-funil')) { s = todos[i]; break; }
      }
    }
    var v = s && s.getAttribute ? (s.getAttribute('data-funil') || '') : '';
    if (!v) {
      var m = document.querySelector('meta[name="lala-funil"]');
      v = m ? (m.getAttribute('content') || '') : '';
    }
    return String(v).toLowerCase().replace(/[^a-z0-9_-]+/g, '').slice(0, 24);
  }
  var FUNIL_DA_PAGINA = funilDaPagina();

  /* a Meta manda o id por parâmetro dinâmico no link do anúncio:
     ...?ad_id={{ad.id}}&adset_id={{adset.id}}&campaign_id={{campaign.id}} */
  var CAMPOS = ['ad_id', 'adset_id', 'campaign_id', 'utm_source', 'utm_medium',
                'utm_campaign', 'utm_content', 'utm_term', 'fbclid', 'gclid', 'ttclid'];

  function daUrl() {
    var p;
    try { p = new URLSearchParams(location.search); } catch (e) { return null; }
    var r = {}, achou = false;
    for (var i = 0; i < CAMPOS.length; i++) {
      var v = (p.get(CAMPOS[i]) || '').trim();
      /* a Meta deixa o `{{ad.id}}` cru quando o parâmetro dinâmico não está
         ligado no anúncio — guardar isso seria guardar lixo que parece id */
      if (!v || v.charAt(0) === '{') continue;
      r[CAMPOS[i]] = v.slice(0, 120);
      achou = true;
    }
    if (!achou) return null;
    r._em = new Date().toISOString();
    r._pagina = location.pathname.slice(0, 200);
    return r;
  }

  function guardado() {
    try {
      var cru = localStorage.getItem(CHAVE);
      if (!cru) return null;
      var o = JSON.parse(cru);
      if (!o || !o.ultimo) return null;
      if (Date.now() - (o._gravadoEm || 0) > DIAS * 86400000) {
        localStorage.removeItem(CHAVE);
        return null;
      }
      return o;
    } catch (e) { return null; }
  }

  function grava(novo) {
    var tinha = guardado();
    var o = {
      primeiro: (tinha && tinha.primeiro) || novo,
      ultimo: novo,
      _gravadoEm: Date.now()
    };
    try { localStorage.setItem(CHAVE, JSON.stringify(o)); } catch (e) { /* modo privado */ }
    return o;
  }

  var chegou = daUrl();
  var estado = chegou ? grava(chegou) : guardado();
  var r = estado && estado.ultimo;

  /* nada pra carimbar: sai sem tocar em nada. Link sem rastro é melhor que
     link com rastro errado.
     ⚠️ MAS: se a página declarou `data-funil`, ela É a origem e tem trabalho
        a fazer mesmo sem rastro na URL — é o caso da aula. */
  if (!r && !FUNIL_DA_PAGINA) return;

  /* um id de visitante, sorteado uma vez e guardado. É ele que faz `F5` não
     virar duas pessoas — a contagem é por arquivo `v/<etiqueta>/<evento>/<vid>`
     e gravar a mesma chave duas vezes não cria duas. */
  function visitante() {
    try {
      var v = localStorage.getItem(CHAVE_VID);
      if (v) return v;
      v = (Date.now().toString(36) + Math.random().toString(36).slice(2, 10))
        .replace(/[^a-z0-9]/g, '');
      localStorage.setItem(CHAVE_VID, v);
      return v;
    } catch (e) {
      /* modo privado: sem armazenamento, cada aba é um visitante novo. Melhor
         contar a mais do que deixar a etapa vazia — e a tela diz que o número
         é de VISITANTES, não de pessoas. */
      return 'anon' + Math.random().toString(36).slice(2, 10);
    }
  }

  /* a etiqueta do funil é o `utm_campaign` — é ele que o link do funil leva
     e é ele que volta no webhook da Kiwify dentro do `sck`. */
  function etiqueta() {
    /* a página-origem manda: numa página que É a boca do funil, o rastro que
       a pessoa trouxe de outro lugar não pode roubar o crédito da aula */
    if (FUNIL_DA_PAGINA) return FUNIL_DA_PAGINA;
    var e = (r && (r.utm_campaign || r.utm_source)) || '';
    return String(e).toLowerCase().replace(/[^a-z0-9_-]+/g, '').slice(0, 24);
  }

  /* ⭐⭐ MÁQUINA NÃO É PESSOA — 22/10/2026. Medido, não suposto.
   *
   * Em 22/10 o painel dizia «218 abriram o quiz» e o rastro próprio do quiz
   * (Firebase) tinha 62 sessões. A conta, hora por hora (Brasília):
   *
   *   21/10 19h→23h : painel 15  · quiz 0
   *   22/10 00h     : painel 76  · quiz 0     ← 76 aberturas numa hora, à meia-noite
   *   22/10 01h     : painel 44  · quiz 0
   *   22/10 06h→15h : painel 68  · quiz 61    ← daqui pra frente os dois batem
   *
   * As ~150 da madrugada são o LOOP DE VERIFICAÇÃO VISUAL da noite em que a
   * VSL foi construída: cada print abre um navegador limpo, navegador limpo é
   * um `lala.vid` novo, e o painel contava cada um como uma pessoa. Nenhuma
   * delas chegou a começar o quiz — por isso o Firebase não as viu.
   *
   * ⚠️ O sinal decisivo é `navigator.webdriver`: TODO navegador dirigido por
   *    programa (Playwright, Puppeteer, Selenium) o põe em `true`, e nenhum
   *    navegador de pessoa põe. É ele que pega o meu próprio loop de prints.
   * ⚠️ Preferir errar deixando de contar: um ping a menos é uma pessoa que a
   *    tela não viu; um ping a mais vira verba realocada por gente que não
   *    existe. Foi este o erro de 218 contra 62.
   * ⚠️ NÃO filtra por «veio do Instagram» nem por tamanho de tela: o
   *    navegador de dentro do Instagram é onde mora quase toda cliente dela
   *    (50 de 62 sessões medidas), e filtrar por aparência derrubaria elas. */
  var ROBO = /bot|crawler|spider|crawling|headless|phantom|slurp|lighthouse|pagespeed|preview|facebookexternalhit|whatsapp|telegrambot|embedly|curl|wget|python-requests|puppeteer|playwright/i;
  function ehMaquina() {
    try {
      if (navigator.webdriver === true) return 'webdriver';
      if (ROBO.test(navigator.userAgent || '')) return 'ua-de-robo';
      /* ⚠️ TIRADO: `!outerWidth && !outerHeight` pegava headless antigo, mas
         navegador de dentro do Instagram também devolve 0 — e 50 das 62
         sessões medidas vieram de lá. Filtro que come cliente real é pior
         que robô que escapa. Headless moderno já cai no `webdriver`. */
      /* ⚠️ NÃO entra «sem idioma» nem «sem plugin» aqui, por tentação que seja:
         são sinais fracos, e um falso positivo aqui apaga uma cliente de
         verdade da contagem. Os três de cima pegam a causa medida. */
      return '';
    } catch (e) { return ''; }
  }
  var MAQUINA = ehMaquina();

  function ping(evento) {
    /* ⚠️ sai ANTES de tocar na etiqueta: o que não se conta não se grava */
    if (MAQUINA) {
      try { console.log('[rastro] ping ignorado (' + MAQUINA + '): ' + evento); } catch (e) {}
      return;
    }
    var et = etiqueta();
    if (!et) return;                 /* sem etiqueta não há o que medir */
    var corpo = JSON.stringify({ et: et, evento: evento, vid: visitante() });
    /* sendBeacon sobrevive à página fechando no clique do checkout; o fetch
       é o plano B de quem não tem beacon. */
    try {
      if (navigator.sendBeacon
        && navigator.sendBeacon(PING, new Blob([corpo], { type: 'text/plain' }))) return;
    } catch (e) { /* segue pro fetch */ }
    try {
      fetch(PING, { method: 'POST', keepalive: true,
        headers: { 'content-type': 'text/plain' }, body: corpo }).catch(function () {});
    } catch (e) { /* medir não pode quebrar a página de vendas */ }
  }

  function ehCheckout(a) {
    try { return CHECKOUT.test(new URL(a.href, location.href).hostname); }
    catch (e) { return false; }
  }

  function ehLanding(a) {
    try { return LANDING.test(new URL(a.href, location.href).hostname); }
    catch (e) { return false; }
  }

  /* ⭐ A SAÍDA DECLARADA (21/10). Até aqui o rastro só sabia contar clique
   * para a landing e para a Kiwify. Mas um funil pode terminar fora da
   * casa — a VSL do 90/10 manda para um formulário no `form.respondi.app`,
   * e aquele clique é a etapa que importa.
   * Agora QUALQUER link marcado com `data-saida="1"` numa página que
   * declarou `data-funil` conta `clique` e leva os mesmos parâmetros.
   * ⚠️ É opt-in de propósito: carimbar todo link externo mandaria a origem
   *    dela para sites de terceiros que não têm nada com isso. */
  function ehSaida(a) {
    var v = a.getAttribute && a.getAttribute('data-saida');
    return !!(v && v !== '0' && v !== 'false');
  }

  /* ⭐ a saída pode DIZER qual etapa ela é: `data-saida="1"` conta `clique`
   * (a etapa do meio), `data-saida="checkout"` conta `checkout` (a última
   * porta antes da conversão). Sem isso, um funil com duas saídas — ir para
   * a aula e depois ir para o formulário — teria as duas no mesmo evento e
   * a queda entre elas sumiria. */
  function eventoDaSaida(a) {
    var v = (a.getAttribute && a.getAttribute('data-saida')) || '';
    return (v === 'checkout' || v === 'chegou' || v === 'clique') ? v : 'clique';
  }

  /* ⭐ O CARIMBO DA PÁGINA-ORIGEM. Na aula, o botão "Quero a Lalá" ia pra
   * landing pelado — e toda venda vinda dali chegava órfã. Agora o próprio
   * rastro.js escreve os parâmetros no link, na hora. Ela não digita nada.
   * ⚠️ Não sobrescreve parâmetro que já esteja escrito no href. */
  function carimbaOrigem(a) {
    if (a.getAttribute('data-rastro') === '1') return;
    var u;
    try { u = new URL(a.href, location.href); } catch (e) { return; }
    function poe(k, v) { if (v && !u.searchParams.has(k)) u.searchParams.set(k, v); }
    poe('utm_source', FUNIL_DA_PAGINA);
    poe('utm_medium', 'origem');
    poe('utm_campaign', FUNIL_DA_PAGINA);
    a.href = u.toString();
    a.setAttribute('data-rastro', '1');
  }

  function carimba(a) {
    if (a.getAttribute('data-rastro') === '1') return;
    if (!r) return;                     // sem rastro trazido, nada a copiar
    var u;
    try { u = new URL(a.href, location.href); } catch (e) { return; }
    /* nunca sobrescreve o que já está no link escrito à mão */
    function poe(k, v) { if (v && !u.searchParams.has(k)) u.searchParams.set(k, v); }
    poe('utm_source', r.utm_source || (r.ad_id ? 'meta' : ''));
    poe('utm_medium', r.utm_medium || (r.ad_id ? 'cpc' : ''));
    poe('utm_campaign', r.utm_campaign);
    poe('utm_content', r.utm_content);
    poe('utm_term', r.utm_term);
    /* ⭐ `sck` É O CAMPO QUE SEMPRE CARREGA A ORIGEM.
     * Vindo de anúncio, leva o `ad_id` — que casa com o gasto da Meta.
     * Vindo de qualquer outro canal (clube, story, direct, bio), leva a
     * ETIQUETA DO CANAL. Assim existe UM campo que nunca vem vazio, e a
     * venda nunca chega sem saber de onde veio.
     * ⚠️ A carteira já separa os dois: só dígito vira `adId`, o resto vira
     *    `marcador`. Nada muda lá. */
    poe('sck', r.ad_id || r.utm_campaign || r.utm_source || '');
    poe('src', r.utm_source || '');
    a.href = u.toString();
    a.setAttribute('data-rastro', '1');
  }

  function campos(form) {
    if (!r) return;
    for (var i = 0; i < CAMPOS.length; i++) {
      var nome = CAMPOS[i], v = r[nome];
      if (!v) continue;
      var el = form.querySelector('[name="' + nome + '"]');
      if (!el) {
        el = document.createElement('input');
        el.type = 'hidden';
        el.name = nome;
        form.appendChild(el);
      }
      if (!el.value) el.value = v;
    }
  }

  function varre() {
    var as = document.getElementsByTagName('a');
    for (var i = 0; i < as.length; i++) {
      if (ehCheckout(as[i])) carimba(as[i]);
      else if (FUNIL_DA_PAGINA && (ehLanding(as[i]) || ehSaida(as[i]))) carimbaOrigem(as[i]);
    }
    var fs = document.getElementsByTagName('form');
    for (var j = 0; j < fs.length; j++) campos(fs[j]);
  }

  varre();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', varre);
  }

  /* ── as etapas que só existem porque alguém avisa ──────────────────────── */
  /* Numa página-origem (a aula) o evento é `origem`: ela ABRIU a peça.
     Na landing é `chegou`: ela chegou na página de vendas. São etapas
     diferentes do mesmo funil e contar as duas como "chegou" apagaria a
     queda entre assistir a aula e clicar no botão — que é justamente o
     número que ela quer. */
  ping(FUNIL_DA_PAGINA ? 'origem' : 'chegou');

  /* ⚠️ o ouvinte é no documento, em captura: botão que nasce depois (modal,
     carrossel) também tem que contar, e um `addEventListener` por link
     perderia os que ainda não existem. */
  document.addEventListener('click', function (ev) {
    for (var n = ev.target; n && n !== document; n = n.parentNode) {
      if (n.tagName !== 'A') continue;
      if (ehCheckout(n)) { ping('checkout'); return; }
      if (ehSaida(n)) {
        if (FUNIL_DA_PAGINA) carimbaOrigem(n); else carimba(n);
        ping(eventoDaSaida(n)); return;
      }
      if (FUNIL_DA_PAGINA && ehLanding(n)) { carimbaOrigem(n); ping('clique'); return; }
    }
  }, true);
  /* botão que só aparece depois (modal, carrossel, conteúdo carregado) também
     precisa sair carimbado — senão a venda vinda dele chega órfã */
  if (window.MutationObserver) {
    new MutationObserver(varre).observe(document.documentElement,
      { childList: true, subtree: true });
  }

  window.lalaRastro = estado;
})();
