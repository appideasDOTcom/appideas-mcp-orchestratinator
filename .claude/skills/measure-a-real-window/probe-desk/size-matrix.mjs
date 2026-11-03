// A message of N lines and C characters, for the paste-wrapper matrix: size-matrix.mjs <lines> <chars> [tag]
const [n,c,tag='']=process.argv.slice(2); const N=Number(n),C=Number(c);
let body=`PROBE-SIZE${tag} L${N}C${C}: reply with the single word ok. `;
const words="lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor".split(" ");
let i=0; while(body.length<C){body+=words[i++%words.length]+" ";} body=body.slice(0,C);
if(N===1){process.stdout.write(body);} else { const per=Math.ceil(body.length/N); const lines=[]; for(let k=0;k<N;k++)lines.push(body.slice(k*per,(k+1)*per)); process.stdout.write(lines.join("\n")); }
