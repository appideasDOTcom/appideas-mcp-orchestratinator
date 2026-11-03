#!/bin/zsh
# One desk as the board sees it, written on change only, every 0.5 s for 2 h.
#   floor-recorder.sh <out-file> <board-url> <channel> <agent>
OUT="$1"; BASE="$2"; CH="$3"; AG="$4"; : > "$OUT"; last=""
for i in $(seq 1 14400); do
  now=$(curl -s --max-time 2 "$BASE/api/floor" | CH="$CH" AG="$AG" node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);
    const c=(j.channels||[]).find(c=>c.channel===process.env.CH);const d=c&&(c.desks||[]).find(d=>d.agent===process.env.AG);
    if(!d){console.log("no desk");return}
    console.log(JSON.stringify({state:d.hosted?.state,live:d.live,hlive:d.hosted?.live,win:d.hosted?.window_open,held:d.hosted?.held,sid:d.session?.session_id,model:d.session?.model,effort:d.session?.effort,compacting:d.session?.compacting,awaiting:d.session?.awaiting_kind,amsg:d.session?.awaiting_message,working:d.working,perm:d.permission&&{id:d.permission.request_id,tool:d.permission.tool,startup:d.permission.startup},delivery:d.delivery,last:d.last_turn&&{id:d.last_turn.id,role:d.last_turn.role,text:String(d.last_turn.text||"").slice(0,80)}}))}catch(e){console.log("err "+e.message)}})' 2>&1)
  if [ "$now" != "$last" ]; then
    { echo "=== $(perl -MTime::HiRes=time -e 'my $t=time; my @g=gmtime($t); printf "%02d:%02d:%02d.%03d", $g[2],$g[1],$g[0],($t-int($t))*1000') ==="; print -r -- "$now"; } >> "$OUT"
    last="$now"
  fi
  sleep 0.5
done
