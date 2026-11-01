import json,re,csv,subprocess
SCR='data/'
subprocess.run(['python3','gen_login.py'],check=True)
subprocess.run(['npx','tailwindcss','-c','tailwind.config.js','-i','input.css','-o','out.css','--minify'],check=True,capture_output=True)
src=open('src.html').read().replace('/*__UIKIT__*/',open('ui_kit.js').read())
css=open('out.css').read()
exp=open('export_app.js').read()
icons=open('icons.json').read()
logos=[open('assets/zuna_logo.b64').read().strip()]
ltm=open('assets/ltm_logo.b64').read().strip()
app=src.replace('__SPLASH__',open('splash.html').read().replace('__SPCLASS__','')).replace('/*__CSS__*/',css).replace('__ICONS__',icons).replace('__ZUNA__',logos[0]).replace('__LTM__',ltm).replace('/*__EXPORT__*/',exp)
open('page.html','w').write(app)
rows=lambda f:list(csv.DictReader(open(SCR+f)))
data={'bookings':rows('ltm_gh_bookings.csv'),'properties':rows('ltm_gh_properties.csv'),'period':json.load(open(SCR+'ltm_gh_period.json'))}
open('preview.html','w').write(app.replace('__USER__',json.dumps({'name':'Suhas','email':'suhas@zuna.ai'})).replace('__DATA__',json.dumps(data).replace('</','<\\/')))
lg=open('login.html').read().replace('</body>',open('cursor_ring.html').read()+'</body>',1).replace('/*__CSS__*/',css).replace('__ZUNA__',logos[0]).replace('__LTM__',ltm).replace('__DOTS__',open('dots.json').read())
open('login_page.html','w').write(lg)
w=open('worker_src.js').read()
adm=open('admin.html').read().replace('/*__UIKIT__*/',open('ui_kit.js').read()).replace('__ICONS__',icons).replace('/*__CSS__*/',css).replace('__ZUNA__',logos[0])
open('admin_page.html','w').write(adm.replace('__ME__',json.dumps({'name':'Suhas','email':'suhas@zuna.ai'})).replace('__STATE__','null'))
err=open('errors.html').read().replace('/*__CSS__*/',css).replace('__ZUNA__',logos[0])
w=w.replace('const LOGIN = "";','const LOGIN = '+json.dumps(lg)+';').replace('const ERRPAGE = "";','const ERRPAGE = '+json.dumps(err)+';').replace('const TEMPLATE = "";','const TEMPLATE = '+json.dumps(app)+';').replace('const ADMIN = "";','const ADMIN = '+json.dumps(adm)+';')
open('worker.js','w').write(w); open('worker.mjs','w').write(w)
print(len(app), len(lg), len(w))
