import sys,base64
from playwright.sync_api import sync_playwright
from PIL import Image
svgf,ref,x0,y0,x1,y1,S,out=sys.argv[1],sys.argv[2],*map(int,sys.argv[3:7]),int(sys.argv[7]),sys.argv[8]
svg=open(svgf).read(); im=Image.open(ref).convert('RGB'); W,H=im.size
with sync_playwright() as p:
    b=p.chromium.launch(); pg=b.new_page(viewport={'width':W*S,'height':H*S})
    pg.set_content(f'<body style="margin:0"><img src="data:image/svg+xml;base64,{base64.b64encode(svg.encode()).decode()}" width={W*S} height={H*S} style="display:block">'); pg.wait_for_timeout(3000)
    pg.screenshot(path='_z.png',clip={'x':x0*S,'y':y0*S,'width':(x1-x0)*S,'height':(y1-y0)*S}); b.close()
a=im.crop((x0,y0,x1,y1)).resize(((x1-x0)*S,(y1-y0)*S),Image.NEAREST); z=Image.open('_z.png').convert('RGB')
w=Image.new('RGB',(a.width,a.height*2+10),'white'); w.paste(a,(0,0)); w.paste(z,(0,a.height+10)); w.save(out)
