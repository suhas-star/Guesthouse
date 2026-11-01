L=open('login_form.html').read().split('\n')
head='\n'.join(L[:43])
T='\n'.join(L); fa=T.index('  <section class="flex flex-col px-6'); fb=T.index('</section>',fa)+len('</section>')
form=T[fa:fb].replace('<section class="flex flex-col px-6','<section class="flex flex-col items-center px-6',1).replace('<p class="a-in text-xs text-zuna-400" style="--d:560ms">','<p class="a-in w-full max-w-sm text-xs text-zuna-400" style="--d:560ms">',1)
sa=T.index('<script>'); sb=T.index('</script>',sa)+len('</script>')
script=T[sa:sb]
script=script.replace("w = $('#wipe');","w = $('#splash');").replace("w.classList.remove('hidden'); w.classList.add('sp-fadein');","w.classList.remove('sp-off'); w.classList.add('sp-fadein');").replace("$('#goTxt').textContent = 'Welcome' + (j.name ? ', ' + j.name.split(' ')[0] : '');","$('#goTxt').textContent = 'Welcome'; const nm = (j.name || '').trim(); try { sessionStorage.setItem('zp.hi', nm || '-'); } catch (e4) {} $('#spHi').textContent = nm ? 'Welcome, ' + nm : 'Welcome';")
script=script.replace("const bars = $('#bars');","const bars = $('#bars'); if (bars)").replace("const rack = $('#rack');","const rack = $('#rack'); if (rack)")
EXTRA='''<style>
@keyframes tick{0%,22%{transform:translateY(0)}25%,47%{transform:translateY(-25%)}50%,72%{transform:translateY(-50%)}75%,97%{transform:translateY(-75%)}100%{transform:translateY(0)}}
.ticker{animation:tick 10s cubic-bezier(.7,0,.3,1) infinite}
#globe{cursor:grab;touch-action:pan-y}
@media (min-width:1024px){main.lgfit{height:100vh;height:100dvh;overflow:hidden}main.lgfit>section:last-child{overflow-y:auto}}
@media (min-width:1024px) and (max-height:780px){
main.lgfit>section:last-child{padding-top:1rem;padding-bottom:1rem}
main.lgfit>section:last-child>.h-9{height:0}
#f,#fp{padding-top:.5rem;padding-bottom:.5rem}
#f img.h-14,#fp img.h-14{height:3rem}
#fp h1.mt-10{margin-top:1rem}
#fp .mt-6{margin-top:1rem}
#f>p.mt-12{margin-top:1.25rem}
#f .mt-7{margin-top:1.25rem}
#f .mt-6{margin-top:1rem}
.gl-head{padding:2rem 2.5rem 0}.gl-head h2{font-size:26px}.gl-head h2.gl-big{font-size:36px}
.gl-foot{padding-left:2.5rem;padding-right:2.5rem;padding-bottom:1.25rem}
}
</style>'''
head=head.replace('</head>',EXTRA+'\n</head>')
import os
VARIANT=os.environ.get('LOGIN_VARIANT','C')
BG='''<div class="absolute inset-0 gridpan"></div>
    <div class="blob1 absolute -top-28 -left-24 w-[420px] h-[420px] rounded-full bg-mint-500/15 blur-3xl"></div>
    <div class="blob2 absolute -bottom-40 -right-24 w-[460px] h-[460px] rounded-full bg-zuna-600/50 blur-3xl"></div>'''
PANELS={
# O: original layout (headline on top, full globe), footer lines removed
'O':'''<section class="hidden lg:flex relative overflow-hidden m-3 rounded-3xl bg-zuna-900 flex-col">
    '''+BG+'''
    <div class="gl-head relative p-12 pb-0 pointer-events-none">
      <h2 class="a-in text-[32px] font-bold text-white leading-tight tracking-tight" style="--d:150ms">Zuna <span class="text-mint-400">Guest House Management</span></h2>
    </div>
    <div class="relative flex-1 min-h-0 mb-6"><canvas id="globe" class="absolute inset-0 w-full h-full" aria-hidden="true"></canvas></div>
  </section>''',
# A: centred globe hero, statement underneath
'A':'''<section class="hidden lg:flex relative overflow-hidden m-3 rounded-3xl bg-zuna-900 flex-col">
    '''+BG+'''
    <div class="relative flex-1 min-h-0"><canvas id="globe" data-r=".42" data-cy=".52" class="absolute inset-0 w-full h-full" aria-hidden="true"></canvas></div>
    <div class="gl-foot relative px-12 pb-12 text-center pointer-events-none">
      <p class="a-in text-[11px] font-bold tracking-[.22em] uppercase text-mint-400" style="--d:150ms">Zuna Guest House Management</p>
      <h2 class="a-in mt-3 text-[30px] font-bold text-white leading-tight tracking-tight" style="--d:250ms">Every room, every night. <span class="text-mint-400">One live view.</span></h2>
    </div>
  </section>''',
# B: planet horizon — big globe rising from the bottom, bold two-line statement on top
'B':'''<section class="hidden lg:flex relative overflow-hidden m-3 rounded-3xl bg-zuna-900 flex-col">
    '''+BG+'''
    <canvas id="globe" data-rbase="w" data-r=".78" data-top=".42" data-lat="-14" data-lift=".45" class="absolute inset-0 w-full h-full" style="-webkit-mask-image:linear-gradient(to bottom,transparent 0,transparent 24%,#000 40%);mask-image:linear-gradient(to bottom,transparent 0,transparent 24%,#000 40%)" aria-hidden="true"></canvas>
    <div class="gl-head relative p-14 pb-0 pointer-events-none">
      <p class="a-in text-[11px] font-bold tracking-[.22em] uppercase text-mint-400" style="--d:150ms">Zuna Guest House Management</p>
      <h2 class="gl-big a-in mt-4 text-[44px] font-bold text-white leading-[1.08] tracking-tight" style="--d:250ms">Corporate stays,<br><span class="text-mint-400">managed in one view.</span></h2>
    </div>
  </section>''',
# C: full globe with a frosted caption card
'C':'''<section class="hidden lg:flex relative overflow-hidden m-3 rounded-3xl bg-zuna-900 flex-col">
    '''+BG+'''
    <canvas id="globe" data-r=".46" data-cy=".44" class="absolute inset-0 w-full h-full" aria-hidden="true"></canvas>
    <div class="relative mt-auto m-8 rounded-2xl bg-white/[.06] ring-1 ring-white/10 backdrop-blur-md px-7 py-6 pointer-events-none">
      <div class="flex items-center gap-2 text-xs font-bold tracking-[.14em] uppercase text-mint-400"><span class="w-2 h-2 rounded-full bg-mint-500 shadow-[0_0_10px_#02C988]"></span>Zuna Guest House Management</div>
      <h2 class="mt-2.5 text-[28px] font-bold text-white leading-tight tracking-tight">Every guest house. <span class="text-mint-400">One live view.</span></h2>
    </div>
  </section>''',
}
panel=PANELS[VARIANT]
body=f'''<main class="lgfit min-h-screen grid lg:grid-cols-2">
  {panel}
  {form}
</main>
{open('splash.html').read().replace('__SPCLASS__','sp-off')}
{script}
<script>window.__DOTS=__DOTS__;</script>
<script>
{open('globe.js').read()}
</script>'''
open('login.html','w').write(head+'\n<body class="bg-white text-zuna-900 antialiased font-sans">\n'+body+'\n</body>\n</html>')
