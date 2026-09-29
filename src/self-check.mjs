import http from "node:http";
import { createCanvas } from "@napi-rs/canvas";
import { spawn } from "node:child_process";
import { config } from "./config.mjs";

const canvas=createCanvas(config.renderWidth,config.renderHeight);
const ctx=canvas.getContext("2d",{alpha:false});
ctx.fillStyle="#111";ctx.fillRect(0,0,canvas.width,canvas.height);
ctx.fillStyle="#fff";ctx.font="48px Arial";ctx.fillText("SELF CHECK",40,80);
const jpeg=canvas.toBuffer("image/jpeg",config.jpegQuality);
if(!jpeg.length) throw new Error("JPEG frame is empty");

const boundary="bbcheck";
const server=http.createServer((req,res)=>{
  if(req.url!=="/mjpeg"){res.writeHead(404);return res.end();}
  res.writeHead(200,{"Content-Type":`multipart/x-mixed-replace; boundary=${boundary}`,"Cache-Control":"no-cache"});
  const packet=Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`),jpeg,Buffer.from("\r\n")]);
  res.write(packet);
  setTimeout(()=>res.end(),300);
});
await new Promise((resolve,reject)=>{server.once("error",reject);server.listen(0,"127.0.0.1",resolve);});
const port=server.address().port;
await new Promise((resolve,reject)=>{
  const ff=spawn("ffmpeg",["-hide_banner","-loglevel","error","-f","mpjpeg","-i",`http://127.0.0.1:${port}/mjpeg`,"-frames:v","1","-f","null","-"],{stdio:["ignore","ignore","pipe"]});
  let err=""; ff.stderr.on("data",x=>err+=x); ff.once("error",reject); ff.once("close",code=>code===0?resolve():reject(new Error(err||`ffmpeg exited ${code}`)));
});
server.close();
console.log("SELF-CHECK OK");
console.log(`Canvas: ${config.renderWidth}x${config.renderHeight}`);
console.log(`JPEG bytes: ${jpeg.byteLength}`);
console.log(`Stream: ${config.width}x${config.height}@${config.fps}`);
console.log("FFmpeg MJPEG input: OK");
