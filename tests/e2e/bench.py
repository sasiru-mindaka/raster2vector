import sys, time, json, base64, subprocess, os, numpy as np
from pathlib import Path
from playwright.sync_api import sync_playwright
from skimage import io
from skimage.metrics import peak_signal_noise_ratio as psnr, structural_similarity as ssim
def run(images, configs, port=8771):
    root = Path(__file__).resolve().parents[2]
    results_dir = root / 'tests' / 'results'; results_dir.mkdir(parents=True, exist_ok=True)
    srv = subprocess.Popen(['python3','-m','http.server',str(port),'--bind','127.0.0.1','-d',str(root)],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); time.sleep(1)
    rows=[]
    try:
        with sync_playwright() as p:
            browser_args=['--no-sandbox','--enable-webgl','--enable-features=Vulkan,WebGPU']
            if os.environ.get('VECTOR_STUDIO_SWIFTSHADER') == '1': browser_args += ['--enable-unsafe-swiftshader','--use-angle=swiftshader']
            b = p.chromium.launch(args=browser_args); 
            for img in images:
                ref = io.imread(img)[..., :3]; H,W = ref.shape[:2]
                for name,cfg in configs.items():
                    pg = b.new_page(viewport={'width':1400,'height':1000}); errs=[]
                    pg.on('pageerror', lambda e: errs.append(str(e)))
                    pg.goto(f'http://localhost:{port}/'); pg.set_input_files('#fileInput', img)
                    pg.wait_for_function("!document.getElementById('traceButton').disabled")
                    for k,v in cfg.items(): pg.evaluate("([k,v])=>{const e=document.getElementById(k);if(e.type==='checkbox'){e.checked=!!v}else{e.value=String(v)};e.dispatchEvent(new Event('input'));e.dispatchEvent(new Event('change'))}",[k,v])
                    t=time.time(); pg.click('#traceButton')
                    pg.wait_for_function("!document.getElementById('downloadButton').disabled || /failed|error/i.test(document.getElementById('statusTitle').textContent)", timeout=1800000)
                    el=time.time()-t; st=pg.inner_text('#statusTitle'); msg=pg.inner_text('#statusMessage')
                    svg = pg.evaluate("fetch(document.getElementById('resultPreview').src).then(r=>r.text())") if 'failed' not in st.lower() else ''
                    pg.close()
                    if not svg: rows.append((img,name,'FAILED '+msg[:80])); continue
                    stem = Path(img).stem
                    (results_dir / f'{stem}_{name.replace(" ","_")}.svg').write_text(svg)
                    pg2 = b.new_page(viewport={'width':W,'height':H})
                    pg2.set_content(f'<body style="margin:0;background:#fff"><img src="data:image/svg+xml;base64,{base64.b64encode(svg.encode()).decode()}" width={W} height={H} style="display:block">'); pg2.wait_for_timeout(2500)
                    png_path = results_dir / f'{stem}_{name.replace(" ","_")}.png'
                    pg2.screenshot(path=str(png_path)); pg2.close()
                    r = io.imread(png_path)[..., :3]; d=np.abs(ref.astype(int)-r).max(2)
                    import re; vp=re.search(r'cover ([0-9.]+)%',msg); gp=re.search(r'(\d+) gradient',msg); tl=re.search(r'(\d+) tile',msg)
                    rows.append((img,name,'PSNR %.2f SSIM %.4f >24:%.3f%% vec %s%% grad %s tiles %s size %.0fKB %.1fs'%(psnr(ref,r),ssim(ref,r,channel_axis=2),100*(d>24).mean(),vp and vp.group(1),gp and gp.group(1),tl and tl.group(1),len(svg)/1024,el)))
                    print(rows[-1],flush=True)
            b.close()
    finally: srv.terminate()
    return rows
if __name__=='__main__':
    imgs=sys.argv[1].split(','); cfgs=json.loads(sys.argv[2]); run(imgs,cfgs)
