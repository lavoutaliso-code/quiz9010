/* ═══════════════════════════════════════════════════════════════════════════
   Quiz do tráfego pago: é pra mim?
   Estado, matemática, navegação e o rastro para lookalike.
   ═══════════════════════════════════════════════════════════════════════════ */

/* cenas: o que roda ao entrar em cada tela (declarado antes de qualquer uso) */
const Cenas = {};
window.Cenas = Cenas;

/* ───────── estado ───────── */
const Q = {
  sessao: null,
  servico: null,
  ticket: 0,
  clientesDia: 6,
  diasMes: 0,
  caminho: null,
  conhece90: null,
  inicio: Date.now()
};

/* a conta — um lugar só, para não existirem duas verdades */
const faturamento = () => Q.ticket * Q.clientesDia * Q.diasMes;
const dobro = () => faturamento() * 2;
const fmt = n => Math.round(n).toLocaleString('pt-BR');

/* ───────── o rastro ─────────
   Grava direto na base da casa (Firebase Realtime), sem servidor no meio:
   assim a página é estática e sobe em qualquer hospedagem.
   Dois lugares, de propósito:
     ev/<dia>/<sessao>/<k>  → o diário bruto, por dia
     sessao/<id>            → uma linha por pessoa, sempre atualizada —
                              é daqui que sai a lista para o público semelhante.
   O PIXEL fica em PIXEL_ID (index.html). Sem o id, nada é enviado à Meta. */
const BASE = 'https://paineldolavou-default-rtdb.firebaseio.com/quiz9010';

const Rastro = {
  fila: [],
  enviando: false,
  resumo: {},   // o que já foi gravado no índice da sessão, para não reescrever igual

  id() {
    let s = null;
    try { s = localStorage.getItem('q9010_sessao'); } catch (e) {}
    if (!s) {
      s = 'q' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
      try { localStorage.setItem('q9010_sessao', s); } catch (e) {}
    }
    return s;
  },

  utm() {
    const p = new URLSearchParams(location.search);
    const o = {};
    ['utm_source','utm_medium','utm_campaign','utm_content','utm_term','fbclid','gclid','sck','src']
      .forEach(k => { const v = p.get(k); if (v) o[k] = v.slice(0, 120); });
    return o;
  },

  marca(evento, dados) {
    const corpo = {
      sessao: Q.sessao,
      evento,
      dados: dados || {},
      quando: new Date().toISOString(),
      tela: Nav.atual,
      segundos: Math.round((Date.now() - Q.inicio) / 1000),
      utm: this.utm(),
      ref: document.referrer ? document.referrer.slice(0, 200) : '',
      tamanho: innerWidth + 'x' + innerHeight,
      idioma: navigator.language || ''
    };
    this.fila.push(corpo);

    /* o índice da sessão: as respostas que importam, em campo próprio */
    const r = this.resumo;
    r.sessao = Q.sessao;
    r.ultimo = corpo.quando;
    if (!r.primeiro) {
      r.primeiro = corpo.quando;
      r.utm = corpo.utm; r.ref = corpo.ref;
      r.tamanho = corpo.tamanho; r.idioma = corpo.idioma;
      r.ua = (navigator.userAgent || '').slice(0, 220);
    }
    if (evento === 'calculou') Object.assign(r, {
      servico: dados.servico, ticket: dados.ticket,
      clientes_dia: dados.clientes_dia, dias_mes: dados.dias_mes,
      faturamento: dados.faturamento, dobro: dados.dobro
    });
    if (evento === 'escolheu_caminho') r.caminho = dados.caminho;
    if (evento === 'conhece_9010') r.conhece_9010 = dados.resposta;
    if (evento === 'clicou_play') r.clicou_play = true;
    if (evento === 'quiz_fim') { r.terminou = true; r.final = dados.final; }
    r.ate_onde = corpo.tela;
    r.segundos = corpo.segundos;

    this.descarrega();

    /* ── espelho no Pixel da Meta ──
       Só os marcos. `entrou_tela` e `respondeu` ficam de fora de propósito:
       são 40+ por pessoa e entupiriam o pixel sem servir de semente. */
    if (window.fbq) {
      const padrao = {
        quiz_inicio: 'ViewContent',
        calculou: 'AddToCart',
        clicou_play: 'Lead',
        quiz_fim: 'CompleteRegistration'
      };
      // "quero faturar mais" é intenção; "estou satisfeita" não é — não vira evento de compra
      if (evento === 'escolheu_caminho' && dados.caminho === 'crescer')
        padrao.escolheu_caminho = 'InitiateCheckout';

      const comum = {
        content_name: 'quiz9010',
        content_category: evento,
        value: Number(r.faturamento) || 0,
        currency: 'BRL'
      };
      if (padrao[evento]) fbq('track', padrao[evento], comum, { eventID: Q.sessao + ':' + evento });

      // um evento próprio por marco, para montar público por nome
      const meus = ['quiz_inicio','calculou','escolheu_caminho','conhece_9010','clicou_play','quiz_fim'];
      if (meus.includes(evento)) fbq('trackCustom', 'q9010_' + evento, {
        ...comum,
        servico: r.servico || '', faturamento: Number(r.faturamento) || 0,
        dobro: Number(r.dobro) || 0, caminho: r.caminho || '',
        final: r.final || '', ate_onde: corpo.tela
      }, { eventID: Q.sessao + ':' + evento });
    }
  },

  /* monta o corpo do PATCH a partir de um lote */
  corpoDoLote(lote) {
    const corpo = {};
    for (const ev of lote) {
      const dia = ev.quando.slice(0, 10);
      const k = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
      corpo[`ev/${dia}/${ev.sessao}/${k}`] = ev;
      corpo[`sessao/${ev.sessao}/eventos/${k}`] =
        { e: ev.evento, t: ev.quando, s: ev.segundos, tela: ev.tela, d: ev.dados };
    }
    for (const [campo, valor] of Object.entries(this.resumo))
      if (valor !== undefined) corpo[`sessao/${Q.sessao}/${campo}`] = valor;
    return corpo;
  },

  /* ⚠️ A PÁGINA VAI SAIR AGORA. Não dá para esperar a fila: `clicou_play` e o
     fim do quiz — os dois eventos que mais importam — morriam no caminho.
     Aqui o lote inteiro vai de uma vez, com keepalive, furando a vez. */
  async fecha() {
    const lote = this.fila.splice(0, this.fila.length);
    try {
      await fetch(BASE + '.json', { method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(this.corpoDoLote(lote)), keepalive: true });
      this.gravados = (this.gravados || 0) + lote.length;
    } catch (e) {}
  },

  /* uma requisição por lote: PATCH de vários caminhos de uma vez */
  async descarrega() {
    if (this.enviando || !this.fila.length) return;
    this.enviando = true;
    const lote = this.fila.splice(0, this.fila.length);
    const corpo = this.corpoDoLote(lote);
    try {
      const r = await fetch(BASE + '.json', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(corpo),
        keepalive: true
      });
      if (!r.ok) throw new Error('http ' + r.status);
      this.gravados = (this.gravados || 0) + lote.length;
    } catch (e) {
      // devolve para a fila: nenhum evento se perde por falha de rede
      this.fila.unshift(...lote);
    } finally {
      this.enviando = false;
      if (this.fila.length) setTimeout(() => this.descarrega(), 2500);
    }
  }
};

/* ───────── a trava, num lugar só ─────────
   O CSS do .off já tira o ponteiro — mas isso é aparência. Quem vale é esta
   guarda: botão travado não dispara handler nenhum, venha o clique de onde vier. */
addEventListener('click', e => {
  const b = e.target.closest && e.target.closest('.btn.off');
  if (b) { e.stopImmediatePropagation(); e.preventDefault(); }
}, true);

/* ───────── navegação ───────── */
const ORDEM = ['t1','t2','t3','t4','t5','t6','t7','t8','t9','t10','t11'];
const Nav = {
  atual: 't1',
  historico: [],
  vai(id, semHistorico) {
    if (id === this.atual) return;
    const de = this.atual;
    if (!semHistorico) this.historico.push(de);
    document.getElementById(de).classList.remove('ativa');
    const el = document.getElementById(id);
    el.classList.add('ativa');
    this.atual = id;
    el.scrollTop = 0;
    Rastro.marca('entrou_tela', { de, para: id });
    if (window.__ajustaTelas) window.__ajustaTelas();
    if (Cenas[id]) Cenas[id]();
  },
  volta() {
    const de = this.historico.pop();
    if (!de) return;
    document.getElementById(this.atual).classList.remove('ativa');
    document.getElementById(de).classList.add('ativa');
    Rastro.marca('voltou', { de: this.atual, para: de });
    this.atual = de;
    if (Cenas[de]) Cenas[de]();
  }
};
document.querySelectorAll('[data-voltar]').forEach(b => b.addEventListener('click', () => Nav.volta()));

/* ═════════ TELA 1 · capa ═════════ */
document.getElementById('b-comecar').addEventListener('click', () => {
  Rastro.marca('clicou_comecar');
  Nav.vai('t2');
});

/* ═════════ TELA 2 · serviço ═════════ */
const SERVICOS = [
  { id:'estetica',   nome:'Estética',            emoji:'✨', ring:'#AFD5FA' },
  { id:'cabelo',     nome:'Cabelo',              emoji:'💇', ring:'#F0A787' },
  { id:'sobrancelha',nome:'Sobrancelha e cílios',emoji:'👁️', ring:'#DB84ED' },
  { id:'unhas',      nome:'Unhas',               emoji:'💅', ring:'#E0F572' },
  { id:'outro',      nome:'Outro serviço',       emoji:'➕', ring:'#D7D7D7' }
];
(function montaServicos(){
  const box = document.getElementById('servicos');
  SERVICOS.forEach(s => {
    const d = document.createElement('div');
    d.className = 'card';
    d.dataset.id = s.id;
    d.innerHTML = `<div class="ic" style="--ring:${s.ring}">${s.emoji}</div>
      <div class="tt"><b>${s.nome}</b></div><div class="ck"></div>`;
    d.addEventListener('click', () => {
      box.querySelectorAll('.card').forEach(x => x.classList.remove('on'));
      d.classList.add('on');
      Q.servico = s;
      document.getElementById('anel2').setAttribute('stroke', s.ring);
      document.getElementById('b-t2').classList.remove('off');
      Rastro.marca('respondeu', { pergunta: 1, campo: 'servico', valor: s.id });
    });
    box.appendChild(d);
  });
})();
document.getElementById('b-t2').addEventListener('click', () => {
  document.getElementById('cupom-servico').textContent = Q.servico ? Q.servico.nome : '—';
  Nav.vai('t3');
});

/* ═════════ TELA 3 · ticket ═════════ */
(function teclaTicket(){
  let buf = '';
  const vEl = document.getElementById('v-ticket'), lEl = document.getElementById('l-ticket');
  const btn = document.getElementById('b-t3');
  const pinta = () => {
    const n = parseInt(buf || '0', 10);
    Q.ticket = n;
    vEl.textContent = buf === '' ? '0' : fmt(n);
    lEl.textContent = 'R$ ' + (buf === '' ? '0' : fmt(n));
    btn.classList.toggle('off', n <= 0);
  };
  document.getElementById('pad-ticket').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    const k = b.dataset.k;
    if (k === 'c') buf = '';
    else if (k === 'b') buf = buf.slice(0, -1);
    else if (buf.length < 6) buf = (buf === '0' ? '' : buf) + b.textContent.trim();
    pinta();
  });
  btn.addEventListener('click', () => {
    Rastro.marca('respondeu', { pergunta: 2, campo: 'ticket', valor: Q.ticket });
    Nav.vai('t4');
  });
  pinta();
})();

/* ═════════ TELA 4 · clientes por dia ═════════ */
(function termometro(){
  const MAX = 20;
  const tubo = document.getElementById('tubo'), liq = document.getElementById('liq');
  const n = document.getElementById('v-dia'), dica = document.getElementById('dicaSeta');
  const pulso = document.getElementById('pulso'), marcas = document.getElementById('marcas');
  let tocou = false, drag = false, buf = '';

  for (let i = 5; i < MAX; i += 5) {
    const b = document.createElement('i'); b.style.bottom = (i / MAX * 100) + '%'; marcas.appendChild(b);
  }
  function pinta() {
    Q.clientesDia = Math.max(1, Math.min(99, Q.clientesDia));
    const pct = Math.min(100, Q.clientesDia / MAX * 100);
    liq.style.height = pct + '%';
    n.textContent = Q.clientesDia;
    const h = tubo.clientHeight, y = h - (pct / 100) * h;
    dica.style.bottom = Math.min(h - 96, (pct / 100) * h + 10) + 'px';
    pulso.style.top = (y - 23) + 'px';
  }
  function cala() {
    if (tocou) return; tocou = true;
    dica.classList.add('off'); pulso.classList.add('off');
    setTimeout(() => { dica.remove(); pulso.remove(); }, 400);
  }
  function doEvento(e) {
    const r = tubo.getBoundingClientRect();
    Q.clientesDia = Math.max(1, Math.round((1 - (e.clientY - r.top) / r.height) * MAX));
    pinta();
  }
  tubo.addEventListener('pointerdown', e => { cala(); drag = true; tubo.setPointerCapture(e.pointerId); doEvento(e); });
  tubo.addEventListener('pointermove', e => { if (drag) doEvento(e); });
  tubo.addEventListener('pointerup', () => drag = false);

  document.getElementById('faixa-dia').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    cala();
    if (b.dataset.k === 'b') buf = buf.slice(0, -1);
    else if (buf.length < 2) buf = (buf === '0' ? '' : buf) + b.textContent.trim();
    Q.clientesDia = Math.max(1, parseInt(buf || '1', 10));
    pinta();
  });
  document.getElementById('b-t4').addEventListener('click', () => {
    Rastro.marca('respondeu', { pergunta: 3, campo: 'clientes_dia', valor: Q.clientesDia });
    Nav.vai('t5');
  });
  Cenas.t4 = pinta;
  pinta();
})();

/* ═════════ TELA 5 · dias por mês ═════════ */
(function roscaDias(){
  const N = 30, CX = 126, CY = 126, R = 96, W = 22, GAP = 2.2;
  const AMARELO = '#E8B429', VERDE = '#2E9E6B', VAZIO = '#DCDCDA';
  const gomos = document.getElementById('gomos'), rosca = document.getElementById('rosca');
  const n = document.getElementById('v-dias'), tag = document.getElementById('tag-dias');
  const seta = document.getElementById('setaRosca');
  let calou = false, drag = false, buf = '';

  const arc = i => {
    const a0 = (i * (360 / N) - 90 + GAP / 2) * Math.PI / 180;
    const a1 = ((i + 1) * (360 / N) - 90 - GAP / 2) * Math.PI / 180;
    return `M${CX + Math.cos(a0) * R} ${CY + Math.sin(a0) * R} A ${R} ${R} 0 0 1 ${CX + Math.cos(a1) * R} ${CY + Math.sin(a1) * R}`;
  };
  for (let i = 0; i < N; i++) {
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', arc(i)); p.setAttribute('fill', 'none');
    p.setAttribute('stroke-width', W); p.setAttribute('stroke-linecap', 'butt');
    p.style.transition = 'stroke .25s';
    gomos.appendChild(p);
  }
  function pinta() {
    Q.diasMes = Math.max(0, Math.min(31, Q.diasMes));
    const vazio = Q.diasMes === 0;
    const cheio = Q.diasMes > 20, cor = cheio ? VERDE : AMARELO;
    [...gomos.children].forEach((p, i) => p.setAttribute('stroke', (!vazio && i < Q.diasMes) ? cor : VAZIO));
    n.textContent = vazio ? '—' : Q.diasMes;
    n.style.color = vazio ? '#C4C4C2' : (cheio ? VERDE : '#242424');
    tag.textContent = vazio ? 'arraste ou digite' : (cheio ? 'mês cheio' : 'ritmo normal');
    tag.style.background = vazio ? 'rgba(0,0,0,.05)' : (cheio ? 'rgba(46,158,107,.12)' : 'rgba(232,180,41,.16)');
    tag.style.color = vazio ? '#9B9B9B' : (cheio ? VERDE : '#A87A12');
    if (seta && seta.parentNode) seta.querySelectorAll('path').forEach(p => p.setAttribute('stroke', vazio ? AMARELO : cor));
    document.getElementById('b-t5').classList.toggle('off', vazio);
  }

  /* demonstração: os gomos acendem um a um, mostrando a ordem do gesto.
     Roda uma vez ao entrar na tela e para no primeiro toque. */
  let demo = null;
  function mostraOrdem() {
    pararDemo();
    if (calou || Q.diasMes > 0) return;
    let i = 0;
    demo = setInterval(() => {
      [...gomos.children].forEach((p, k) => {
        p.setAttribute('stroke', k === i ? AMARELO : (k < i ? 'rgba(232,180,41,.32)' : VAZIO));
      });
      i++;
      if (i > N) { pararDemo(); setTimeout(() => { if (!calou && Q.diasMes === 0) mostraOrdem(); }, 700); }
    }, 55);
  }
  function pararDemo() { if (demo) { clearInterval(demo); demo = null; } }
  function cala() { pararDemo(); if (calou) return; calou = true; seta.classList.add('off'); setTimeout(() => seta.remove(), 400); }
  function doEvento(e) {
    const r = document.getElementById('svgRosca').getBoundingClientRect();
    let a = Math.atan2(e.clientY - (r.top + r.height / 2), e.clientX - (r.left + r.width / 2)) * 180 / Math.PI + 90;
    if (a < 0) a += 360;
    Q.diasMes = Math.max(1, Math.round(a / 360 * N));
    pinta();
  }
  rosca.addEventListener('pointerdown', e => { cala(); drag = true; rosca.setPointerCapture(e.pointerId); doEvento(e); });
  rosca.addEventListener('pointermove', e => { if (drag) doEvento(e); });
  rosca.addEventListener('pointerup', () => drag = false);

  document.getElementById('faixa-dias').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    cala();
    if (b.dataset.k === 'b') buf = buf.slice(0, -1);
    else if (buf.length < 2) buf = (buf === '0' ? '' : buf) + b.textContent.trim();
    Q.diasMes = Math.max(1, Math.min(31, parseInt(buf || '1', 10)));
    pinta();
  });
  document.getElementById('b-t5').addEventListener('click', () => {
    Rastro.marca('respondeu', { pergunta: 4, campo: 'dias_mes', valor: Q.diasMes });
    Rastro.marca('calculou', {
      ticket: Q.ticket, clientes_dia: Q.clientesDia, dias_mes: Q.diasMes,
      faturamento: faturamento(), dobro: dobro(), servico: Q.servico && Q.servico.id
    });
    Nav.vai('t6');
  });
  Cenas.t5 = () => { pinta(); if (Q.diasMes === 0) mostraOrdem(); };
  pinta();
})();

/* ═════════ TELA 6 · resultado ═════════ */
Cenas.t6 = function () {
  const el = document.getElementById('v-mes');
  document.getElementById('c-ticket').textContent = fmt(Q.ticket);
  document.getElementById('c-dia').textContent = Q.clientesDia;
  document.getElementById('c-dias').textContent = Q.diasMes;
  const alvo = faturamento(), t0 = performance.now();
  const passo = now => {
    const p = Math.min(1, (now - t0) / 1600);
    el.textContent = fmt(alvo * (1 - Math.pow(1 - p, 3)));
    if (p < 1) requestAnimationFrame(passo);
  };
  requestAnimationFrame(passo);
};
document.getElementById('b-verconta').addEventListener('click', () => {
  const c = document.getElementById('contaBox');
  c.classList.toggle('on');
  document.getElementById('b-verconta').textContent =
    c.classList.contains('on') ? 'esconder a conta' : 'como cheguei nesse número';
  Rastro.marca('abriu_conta');
});
document.getElementById('caminhos').addEventListener('click', e => {
  const o = e.target.closest('.op'); if (!o) return;
  document.querySelectorAll('#caminhos .op').forEach(x => x.classList.remove('on'));
  o.classList.add('on');
  Q.caminho = o.dataset.c;
  document.getElementById('b-t6').classList.remove('off');
  Rastro.marca('escolheu_caminho', { caminho: Q.caminho });
});
document.getElementById('b-t6').addEventListener('click', () => {
  if (Q.caminho === 'satisfeita') {
    document.getElementById('fim-ttl').textContent = 'Combinado.';
    document.getElementById('fim-txt').textContent =
      'Se um dia quiser crescer, o caminho continua aqui.';
    Rastro.marca('quiz_fim', { final: 'satisfeita', faturamento: faturamento() });
    Nav.vai('t11');
  } else {
    Nav.vai('t7');
  }
});

/* ═════════ TELA 7 · parabéns ═════════ */
const CORES = ['#FFD54A','#2E9E6B','#5A9FE8','#E86A8F','#B07FE8','#F0A864','#4FC28C','#F2B705'];
(function confete(){
  const box = document.getElementById('confete'), N = 20;
  for (let i = 0; i < N; i++) {
    const p = document.createElement('i');
    const ang = i * 137.508 * Math.PI / 180, raio = 34 + ((i % 3) * 3.4);
    p.style.width = (4 + ((i * 7) % 4)) + 'px';
    p.style.height = (6 + ((i * 11) % 5)) + 'px';
    p.style.left = (50 + Math.cos(ang) * raio) + '%';
    p.style.top = (50 + Math.sin(ang) * raio) + '%';
    p.style.background = CORES[i % CORES.length];
    p.style.setProperty('--atraso', (0.3 + ((i * 53) % 600) / 1000) + 's');
    p.style.setProperty('--d', (0.9 + ((i * 19) % 60) / 100) + 's');
    p.style.setProperty('--giro', (((i * 97) % 720) - 360) + 'deg');
    box.appendChild(p);
  }
})();
Cenas.t7 = function () {
  document.getElementById('p-hoje').textContent = fmt(faturamento());
  document.getElementById('p-cabe').textContent = fmt(dobro());
  const fio = document.getElementById('fio7');
  fio.classList.remove('anda'); void fio.offsetWidth; fio.classList.add('anda');
  document.getElementById('pil-hoje').classList.add('v');
  ['pil-cabe','m-pra','d1','d2','m-sai'].forEach(id => document.getElementById(id).classList.remove('v','on'));
  setTimeout(() => document.getElementById('m-sai').classList.add('v'), 550);
  setTimeout(() => document.getElementById('d1').classList.add('on'), 1250);
  setTimeout(() => document.getElementById('d2').classList.add('on'), 1900);
  setTimeout(() => document.getElementById('pil-cabe').classList.add('v'), 2300);
  setTimeout(() => document.getElementById('m-pra').classList.add('v'), 2500);
};
document.getElementById('b-t7-sim').addEventListener('click', () => {
  Rastro.marca('quer_saber_caminho', { resposta: 'sim' });
  Nav.vai('t8');
});
document.getElementById('b-t7-nao').addEventListener('click', () => {
  document.getElementById('fim-ttl').textContent = 'Tudo bem.';
  document.getElementById('fim-txt').textContent = 'Quando quiser, é só voltar.';
  Rastro.marca('quiz_fim', { final: 'deixa_pra_la', faturamento: faturamento() });
  Nav.vai('t11');
});

/* ═════════ TELA 8 · 90/10 ═════════ */
const CONVERSAS = [
  { nome:'Camila', cor:'linear-gradient(140deg,#FFD9A8,#F0A864)',
    msgs:[{de:'dela',t:'amiga, <mark class="forte">minha agenda não tem mais buraco</mark> 😭',h:'14:28'},
          {de:'minha',t:'mas o que você fez??',h:'14:29'},
          {de:'dela',t:'<mark>te conto no domingo</mark> 🤫',h:'14:32'},
          {de:'minha',t:'ah não, fala agora 😩',h:'14:33'},
          {de:'dela',t:'é rápido de entender, prometo',h:'14:35'}]},
  { nome:'Rafa', cor:'linear-gradient(140deg,#C9F2E0,#64C9A4)',
    msgs:[{de:'dela',t:'antes eu atendia <mark>6 por semana</mark>',h:'09:11'},
          {de:'minha',t:'e agora?',h:'09:12'},
          {de:'dela',t:'<mark class="forte">25</mark>. e nem mexi no preço 🙏',h:'09:15'},
          {de:'minha',t:'MENINA',h:'09:16'},
          {de:'dela',t:'eu fiquei anos sem saber 🫠',h:'09:18'}]},
  { nome:'Dani', cor:'linear-gradient(140deg,#BFD9F5,#5A9FE8)',
    msgs:[{de:'dela',t:'semana inteira fechada já',h:'17:19'},
          {de:'minha',t:'mas o que mudou??',h:'17:20'},
          {de:'dela',t:'<mark>não posso falar aqui</mark> 👀',h:'17:22'},
          {de:'minha',t:'kkkkk para',h:'17:23'},
          {de:'dela',t:'depois você entende',h:'17:24'}]},
  { nome:'Si', cor:'linear-gradient(140deg,#FFE3A8,#E8B429)',
    msgs:[{de:'dela',t:'mesma equipe, mesmo preço, <mark class="forte">o dobro de cliente</mark>',h:'08:36'},
          {de:'minha',t:'não acredito',h:'08:38'},
          {de:'dela',t:'<mark>tem nome, viu</mark>',h:'08:40'},
          {de:'minha',t:'qual?? 😤',h:'08:41'},
          {de:'dela',t:'você vai descobrir',h:'08:43'}]}
];
const CHECK = '<svg width="10" height="6" viewBox="0 0 16 10" fill="none"><path d="M1 5.5 4 8.5 9.5 2" stroke="#53BDEB" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/><path d="M6.5 5.5 9.5 8.5 15 2" stroke="#53BDEB" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';
(function montaEsteira(){
  const c = document.getElementById('corre8');
  const print = x => {
    const el = document.createElement('div'); el.className = 'zap';
    el.innerHTML = `<div class="top"><span class="volta">‹</span><span class="avz" style="background:${x.cor}"></span>
      <span class="quem"><b>${x.nome}</b><s>online</s></span></div><div class="chat">` +
      x.msgs.map(m => `<div class="bolha ${m.de}">${m.t}<div class="hr"><span>${m.h}</span>${m.de === 'minha' ? CHECK : ''}</div></div>`).join('') +
      `</div>`;
    return el;
  };
  [...CONVERSAS, ...CONVERSAS].forEach(x => c.appendChild(print(x)));
})();
Cenas.t8 = function () {
  const num = document.getElementById('num8'), giz = document.getElementById('giz8');
  const mas = document.getElementById('mas8'), grifo = document.getElementById('grifo8');
  [num, giz, mas, grifo].forEach(e => e.classList.remove('v'));
  setTimeout(() => num.classList.add('v'), 250);
  setTimeout(() => giz.classList.add('v'), 850);
  setTimeout(() => mas.classList.add('v'), 2150);
  setTimeout(() => grifo.classList.add('v'), 2450);
};
document.getElementById('b-t8-sim').addEventListener('click', () => {
  Q.conhece90 = 'nao';
  Rastro.marca('conhece_9010', { resposta: 'me_conta' });
  Nav.vai('t9');
});
document.getElementById('b-t8-nao').addEventListener('click', () => {
  Q.conhece90 = 'sim';
  Rastro.marca('conhece_9010', { resposta: 'ja_conheco' });
  Nav.vai('t9');
});

/* ═════════ TELA 9 · play ═════════ */
document.getElementById('b-t9').addEventListener('click', () => {
  Rastro.marca('clicou_play', {
    faturamento: faturamento(), dobro: dobro(),
    servico: Q.servico && Q.servico.id, caminho: Q.caminho, conhece90: Q.conhece90
  });
  Rastro.marca('quiz_fim', {
    final: 'foi_para_a_aula', faturamento: faturamento(), dobro: dobro(),
    servico: Q.servico && Q.servico.id
  });
  /* a aula existe de verdade: a pessoa sai do quiz e vai para ela, levando o
     rastro junto (a sessão e a origem) para o funil não se perder no caminho. */
  const p = new URLSearchParams(Rastro.utm());
  p.set('s', Q.sessao);
  p.set('fat', String(faturamento()));
  let foi = false;
  const ir = () => { if (!foi) { foi = true; location.href = 'vsl/?' + p.toString();   // relativo À PASTA do quiz, nunca '../' } };
  Rastro.fecha().then(ir);
  setTimeout(ir, 1800);   // se a rede falhar, a pessoa vai para a aula do mesmo jeito
});

/* ═════════ TELA 10 · vídeo ═════════ */
Cenas.t10 = function () {
  const b = document.getElementById('barraVid');
  b.style.width = '0'; void b.offsetWidth;
  let p = 0;
  const t = setInterval(() => {
    p += 2; b.style.width = Math.min(100, p) + '%';
    if (p >= 100) clearInterval(t);
  }, 400);
};
document.getElementById('b-t10').addEventListener('click', () => {
  document.getElementById('fim-ttl').textContent = 'Agora você sabe.';
  document.getElementById('fim-txt').textContent =
    'O 90/10 está anotado no seu papel. O próximo passo é aplicar no seu negócio.';
  Rastro.marca('quiz_fim', {
    final: 'assistiu', faturamento: faturamento(), dobro: dobro(),
    servico: Q.servico && Q.servico.id
  });
  Nav.vai('t11');
});

/* ───────── arranque ───────── */
Q.sessao = Rastro.id();
Rastro.marca('quiz_inicio', { utm: Rastro.utm() });
/* quem fecha a aba no meio também conta: o sendBeacon só sabe fazer POST,
   e POST na Firebase empilha um filho — cai no lugar certo da sessão. */
function despede() {
  if (!Rastro.fila.length) return;
  try {
    const pacote = Rastro.fila.map(ev =>
      ({ e: ev.evento, t: ev.quando, s: ev.segundos, tela: ev.tela, d: ev.dados, saiu: true }));
    const ok = navigator.sendBeacon(
      `${BASE}/sessao/${Q.sessao}/eventos.json`,
      new Blob([JSON.stringify({ lote: pacote, resumo: Rastro.resumo })],
               { type: 'text/plain;charset=UTF-8' }));
    if (ok) Rastro.fila = [];
  } catch (e) {}
}
addEventListener('pagehide', despede);
addEventListener('visibilitychange', () => { if (document.hidden) despede(); });
/* expõe para o teste automatizado */
window.__Q = Q;
window.__faturamento = faturamento;
window.__dobro = dobro;
window.__Nav = Nav;
window.__Rastro = Rastro;

/* ═══════════════════════════════════════════════════════════════════════════
   CADA TELA SE AJUSTA À ALTURA DO APARELHO
   As telas foram desenhadas para 844px. Em celular real sobra bem menos
   (barra de endereço, iPhone SE, tela dividida) e o Continuar saía da tela.
   Aqui o conteúdo de cada tela vai para dentro de um «palco» com a altura
   de projeto, e o palco encolhe proporcionalmente até caber. Nada é cortado,
   nada rola, e o botão fica sempre alcançável.
   ═══════════════════════════════════════════════════════════════════════════ */
(function encaixaNaTela() {
  const ALVO = 804;            // altura útil para a qual as telas foram feitas
  const telas = [...document.querySelectorAll('.tela')];

  telas.forEach(t => {
    const palco = document.createElement('div');
    palco.className = 'palco';
    while (t.firstChild) palco.appendChild(t.firstChild);
    t.appendChild(palco);
  });

  /* ⚠️ o palco fica NO FLUXO e sem position. Se fosse `position:absolute`, ele
     viraria a referência dos elementos posicionados de dentro (o termômetro e a
     rosca) e eles subiam POR CIMA do Continuar — o botão parava de clicar.
     A rolagem é evitada por outro caminho: margem negativa que devolve ao fluxo
     a altura que a escala tirou. */
  const css = document.createElement('style');
  css.textContent = `.palco{flex:0 0 auto;display:flex;flex-direction:column;
    align-items:center;width:100%;height:${ALVO}px;transform-origin:top center;
    will-change:transform}`;
  document.head.appendChild(css);

  function ajusta() {
    /* ⚠️ a altura vem da JANELA, nunca do elemento: tela escondida mede 0 e a
       escala sairia NEGATIVA — a tela aparecia de cabeça para baixo. */
    const janela = (window.visualViewport ? visualViewport.height : innerHeight) || 844;
    telas.forEach(t => {
      const cs = getComputedStyle(t);
      const disp = janela - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
      const k = Math.max(.45, Math.min(1, disp / ALVO));   // nunca invertido, nunca microscópico
      const p = t.querySelector('.palco');
      if (k < 1) {
        p.style.width = (100 / k) + '%';
        p.style.transform = 'scale(' + k + ')';
        p.style.marginBottom = (-(ALVO * (1 - k))) + 'px';   // tira do fluxo o que a escala encolheu
      } else {
        p.style.width = '100%';
        p.style.transform = 'none';
        p.style.marginBottom = '0px';
      }
    });
  }

  ajusta();
  addEventListener('resize', ajusta);
  addEventListener('orientationchange', () => setTimeout(ajusta, 220));
  if (window.visualViewport) visualViewport.addEventListener('resize', ajusta);
  window.__ajustaTelas = ajusta;
})();
