import json, math, sys
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
G=json.load(open(sys.argv[1]))
SURF="#fcfcfb"; INK="#0b0b0b"; INK2="#52514e"; MUTED="#8a8984"; GRID="#e7e6e2"; BLUE="#2a78d6"
SLOTS=["#2a78d6","#eb6834","#1baf7a","#eda100","#e87ba4"]; OTHER="#b9b8b2"
short={"Citilink Airbus A320-214":"Citilink A320","Pelita Air Airbus A320-214":"Pelita Air A320","Boeing 737-8U3":"Garuda B737-800",
 "Airbus A330-941 (A339)":"A330-900neo","Citilink A320-251 NEO":"Citilink A320neo","Boeing 777-3U3 ER(W)":"B777-300ER",
 "Boeing 737-8":"B737 MAX 8","Airbus A330-343 (A333)":"A330-300","Sriwijaya Air B737-800NG":"Sriwijaya B737-800"}
plt.rcParams.update({"font.family":"DejaVu Sans","font.size":11,"text.color":INK,"axes.labelcolor":INK2,"xtick.color":INK2,"ytick.color":INK})
fig=plt.figure(figsize=(15,7.2),facecolor=SURF)
fig.suptitle("IJV green operations by fleet family · 16 Sep – 8 Nov 2026",x=0.04,ha="left",y=0.975,fontsize=17,fontweight="bold")
fig.text(0.04,0.905,"Green ops = single-engine taxi-in (Airbus + Boeing) and CONF 3 reduced-flap landings (Airbus only). 1,266 landings with ACARS data.",fontsize=11,color=INK2)
pie=sorted(G,key=lambda x:-x['act']); top=pie[:5]; other=sum(x['act'] for x in pie[5:]); tot=sum(x['act'] for x in pie)
vals=[x['act'] for x in top]+[other]; labs=[short.get(x['fleet'],x['fleet']) for x in top]+["Other"]; cols=SLOTS+[OTHER]
keep=[i for i,v in enumerate(vals) if v>0]; vals=[vals[i] for i in keep]; labs=[labs[i] for i in keep]; cols=[cols[i] for i in keep]
ax=fig.add_axes([0.11,0.09,0.34,0.68]); ax.set_facecolor(SURF)
w,_=ax.pie(vals,colors=cols,startangle=90,counterclock=False,wedgeprops=dict(edgecolor=SURF,linewidth=2))
for wd,l,v in zip(w,labs,vals):
    a=math.radians((wd.theta1+wd.theta2)/2); x,y=math.cos(a),math.sin(a)
    ax.annotate(f"{l}\n{v} · {100*v/tot:.0f}%",xy=(0.98*x,0.98*y),xytext=(1.3*x,1.22*y),ha="left" if x>0 else "right",va="center",fontsize=10.5,color=INK,arrowprops=dict(arrowstyle="-",color=MUTED,lw=0.8))
ax.set_title(f"Share of all green-ops actions ({tot})\nmostly reflects how much each fleet flies",fontsize=12,color=INK2,pad=18)
ax.set_aspect("equal")
B=[x for x in G if x['n']>=20 and x['eng']>=20]; B.sort(key=lambda x:x['rate'])
bx=fig.add_axes([0.665,0.15,0.31,0.65]); bx.set_facecolor(SURF)
names=[short.get(x['fleet'],x['fleet']) for x in B]; rates=[100*x['rate'] for x in B]
bars=bx.barh(names,rates,color=BLUE,height=0.62,edgecolor=SURF,linewidth=2)
for b,x,r in zip(bars,B,rates):
    det=f"SETI {x['seti']}/{x['eng']}"+(f" · CONF 3 {x['conf3']}/{x['ab']}" if x['ab'] else "")
    yy=b.get_y()+b.get_height()/2
    bx.text(r+1,yy,f"{r:.0f}%",va="center",fontsize=10.5,fontweight="bold",color=INK)
    bx.text(r+10.5,yy,det,va="center",fontsize=9,color=INK2)
bx.set_xlim(0,100); bx.set_xlabel("Green-ops compliance (% of opportunities)",color=INK2)
for s in ("top","right","left"): bx.spines[s].set_visible(False)
bx.spines["bottom"].set_color(GRID); bx.tick_params(axis="y",length=0); bx.xaxis.grid(True,color=GRID,lw=0.8); bx.set_axisbelow(True)
bx.set_xticks([0,20,40,60]); bx.set_xticklabels(["0%","20%","40%","60%"])
bx.set_title("Which fleet family complies most",fontsize=12,color=INK2,loc="left",pad=12)
fig.text(0.04,0.015,"Families: A330 = A330-300 + A330-900; B737 NG/MAX = Garuda 737-800 + 737 MAX 8; Citilink A320 family = A320ceo + A320neo. Sriwijaya and 737 Classics excluded.\nBoeing fleets can only score SETI (no CONF 3 rule).",fontsize=9,color=MUTED)
fig.savefig(sys.argv[2],dpi=200,facecolor=SURF); print(sys.argv[2])
