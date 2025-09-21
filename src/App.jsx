// src/App.jsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Capacitor } from "@capacitor/core";
import { Camera, CameraDirection, CameraResultType, CameraSource } from "@capacitor/camera";
import { BarcodeScanner } from "@capacitor-mlkit/barcode-scanning";
import { TextRecognition } from "@capacitor-mlkit/text-recognition";

/* ====== Util ====== */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const toRad = (d) => (d * Math.PI) / 180;
const looksLikeAddress = (s="") =>
  /calle|c\/|avda|avenida|plaza|camino|carretera|barrio|carrer|paseo|ps\./i.test(s) ||
  /\d{4,5}/.test(s) || s.includes(",");

function haversine(a, b) {
  const R = 6371;
  const dLat = toRad(b[0] - a[0]);
  const dLon = toRad(b[1] - a[1]);
  const la1 = toRad(a[0]);
  const la2 = toRad(b[0]);
  const h = Math.sin(dLat/2)**2 + Math.cos(la1)*Math.cos(la2)*Math.sin(dLon/2)**2;
  return 2*R*Math.asin(Math.sqrt(h));
}

/* ====== Geocoding con fallback ====== */
async function geocodeOSM(q, opts={}) {
  const base = "https://nominatim.openstreetmap.org/search";
  const url = `${base}?format=jsonv2&q=${encodeURIComponent(q)}&countrycodes=es&addressdetails=1`;
  const res = await fetch(url, { headers:{
    Accept:"application/json",
    "User-Agent":"TonyRutas/1.0"
  }});
  if (!res.ok) throw new Error("geocode http");
  const data = await res.json();
  if (!Array.isArray(data) || data.length===0) throw new Error("no results");
  const hit = data[0];
  return { lat: +hit.lat, lon: +hit.lon, displayName: hit.display_name };
}

async function smartGeocode(input, defaultCity) {
  const tries = [
    input,
    `${input}, ${defaultCity}`,
    `${input}, España`,
  ];
  for (const q of tries) {
    try {
      return await geocodeOSM(q);
    } catch {}
  }
  throw new Error("Sin resultados");
}

/* ====== Parser de códigos ====== */
function parseScannedText(raw) {
  if (!raw) return { name:"", address:"" };
  const t = raw.trim();

  // JSON directo
  try {
    const obj = JSON.parse(t);
    const address = obj.address || obj.dir || obj.direccion || "";
    const name = obj.name || obj.nombre || "";
    if (address) return { name: name || "Sin nombre", address };
  } catch {}

  // JSON con comillas simples / claves distintas
  if (t.startsWith("{") && t.endsWith("}")) {
    try {
      const fixed = t
        .replace(/'/g,'"')
        .replace(/\bnombre\b/g,'"name"')
        .replace(/\bdireccion\b/g,'"address"')
        .replace(/\bdir\b/g,'"address"');
      const obj = JSON.parse(fixed);
      const address = obj.address || "";
      const name = obj.name || "";
      if (address) return { name: name || "Sin nombre", address };
    } catch {}
  }

  // "Nombre | Dirección"
  const pipe = t.split("|");
  if (pipe.length===2) return { name: pipe[0].trim()||"Sin nombre", address: pipe[1].trim() };

  // 2+ líneas
  const lines = t.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
  if (lines.length>=2) {
    // Buscar línea con CP/dirección
    let addrLine = lines.find(L => looksLikeAddress(L)) || lines.slice(1).join(", ");
    const name = lines[0] || "Sin nombre";
    return { name, address: addrLine };
  }

  // address: ..., dir: ...
  const m = t.match(/\b(address|direccion|dir)\s*[:=]\s*([^}\n\r]+)/i);
  if (m) return { name:"Sin nombre", address: m[2].trim() };

  // Si parece dirección, úsala
  if (looksLikeAddress(t)) return { name:"Sin nombre", address: t };

  // Probable tracking (Amazon/GLS…)
  return { name: t, address: "" };
}

/* ====== Escáner Web (fallback) ====== */
function WebScanner({ onCancel, onResult }) {
  const videoRef = useRef(null);
  const rafRef = useRef(0);

  const supported = "BarcodeDetector" in window ? window.BarcodeDetector : null;
  const detectorRef = useRef(null);

  useEffect(() => {
    let stream, disposed=false;
    async function start() {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video:{ facingMode:{ideal:"environment"}, width:{ideal:1280}, height:{ideal:720} }, audio:false
        });
        if (disposed) return;
        videoRef.current.srcObject = stream;
        await videoRef.current.play();

        if (!supported) { alert("Sin soporte de lector en el navegador."); onCancel(); return; }
        let formats = ["qr_code","code_128","code_39","code_93","ean_13","ean_8","upc_a","upc_e","itf","codabar","data_matrix","pdf417","aztec"];
        try {
          if (supported.getSupportedFormats) {
            const sup = await supported.getSupportedFormats();
            formats = formats.filter(f=>sup.includes(f));
          }
        } catch {}
        detectorRef.current = new supported({ formats });

        const tick = async () => {
          if (disposed) return;
          try {
            const codes = await detectorRef.current.detect(videoRef.current);
            if (codes?.length) {
              const best = codes[0];
              onResult({ raw: best.rawValue || "", type: best.format || "unknown" });
              return;
            }
          } catch {}
          rafRef.current = requestAnimationFrame(tick);
        };
        rafRef.current = requestAnimationFrame(tick);
      } catch {
        alert("No se pudo abrir la cámara (web)."); onCancel();
      }
    }
    start();
    return () => {
      disposed=true;
      cancelAnimationFrame(rafRef.current);
      try { stream?.getTracks().forEach(t=>t.stop()); } catch {}
    };
  }, [onCancel, onResult]);

  return (
    <div style={st.overlay}>
      <div style={st.scanBox}>
        <video ref={videoRef} playsInline style={st.video}/>
        <div style={st.frame}/>
        <button onClick={onCancel} style={st.close}>Cerrar</button>
      </div>
    </div>
  );
}

/* ====== App ====== */
export default function App(){
  const [defaultCity, setDefaultCity] = useState("Benicarló, Castellón, España");

  const [originText, setOriginText] = useState("");
  const [originLL, setOriginLL]   = useState(null);

  const [name, setName] = useState("");
  const [addr, setAddr] = useState("");
  const [note, setNote] = useState("");
  const [photo, setPhoto] = useState("");

  const [list, setList] = useState([]);
  const [km, setKm] = useState(0);

  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const isNative = Capacitor.isNativePlatform();

  // Distancia
  useEffect(() => {
    if (!originLL || list.length===0) { setKm(0); return; }
    let sum=0, prev=originLL;
    for (const it of list) {
      if (!it.lat || !it.lon) { setKm(0); return; }
      sum += haversine([prev.lat, prev.lon], [it.lat, it.lon]);
      prev = { lat: it.lat, lon: it.lon };
    }
    setKm(Math.round(sum*10)/10);
  }, [originLL, list]);

  async function setOrigin() {
    if (!originText.trim()) return;
    setBusy(true);
    try {
      const g = await smartGeocode(originText.trim(), defaultCity);
      setOriginLL(g);
    } catch {
      alert("No pude localizar ese origen. Añade ciudad/CP.");
    } finally { setBusy(false); }
  }

  async function addItem() {
    if (!addr.trim()) { alert("Falta dirección"); return; }
    setBusy(true);
    try {
      const g = await smartGeocode(addr.trim(), defaultCity);
      const id = Date.now().toString(36)+Math.random().toString(36).slice(2,6);
      setList(x => [...x, { id, name: name.trim()||"Sin nombre", address: addr.trim(), displayName: g.displayName, lat:g.lat, lon:g.lon, note: note.trim(), photo }]);
      setName(""); setAddr(""); setNote(""); setPhoto("");
    } catch {
      alert("No pude localizar esa dirección. Prueba añadiendo ciudad/CP o ajusta la ciudad por defecto.");
    } finally { setBusy(false); }
  }

  // Escáner universal (nativo → MLKit; web → BarcodeDetector)
  async function scanCode(){
    if (isNative) {
      try {
        const ok = await BarcodeScanner.isSupported();
        if (!ok) throw new Error("not supported");
        const perm = await BarcodeScanner.requestPermissions();
        if (perm.camera !== "granted") { alert("Permiso de cámara denegado"); return; }
        const res = await BarcodeScanner.scan();
        if (res?.barcodes?.length) {
          const raw = res.barcodes[0].rawValue || "";
          const parsed = parseScannedText(raw);
          if (parsed.address) { setAddr(parsed.address); }
          if (parsed.name)    { setName(parsed.name); }
          if (!parsed.address) alert("Código detectado (seguimiento). Escanea un QR con dirección o usa OCR desde foto.");
        } else {
          alert("No se detectó ningún código");
        }
      } catch {
        // Fallback a web
        setScanning(true);
      }
    } else {
      setScanning(true);
    }
  }

  function onWebScanResult({ raw }){
    const parsed = parseScannedText(raw);
    if (parsed.address) setAddr(parsed.address);
    if (parsed.name) setName(parsed.name);
    if (!parsed.address) alert("Código detectado (seguimiento). Escanea un QR con dirección o usa OCR desde foto.");
    setScanning(false);
  }

  // OCR desde foto de etiqueta
  async function ocrFromPhoto(){
    try {
      const p = await Camera.getPhoto({
        source: CameraSource.Camera,
        direction: CameraDirection.Rear,
        resultType: CameraResultType.Uri,
        quality: 80
      });
      if (!p || !p.path) { alert("No se obtuvo imagen"); return; }

      const perms = await TextRecognition.requestPermissions();
      if (perms.camera !== "granted" && perms.photos !== "granted") {
        // algunos dispositivos devuelven "limited" o similar: intentamos igualmente
      }
      const { recognizedText } = await TextRecognition.recognizeImage({ path: p.path });
      const text = recognizedText || "";
      if (!text.trim()) { alert("No se leyó texto en la etiqueta"); return; }

      // Heurística simple: buscar líneas útiles
      const lines = text.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);

      // Nombre: primera línea “limpia” que no parezca dirección
      const probableName = lines.find(L => !looksLikeAddress(L) && !/^\d+$/.test(L)) || "Sin nombre";

      // Dirección:  línea con palabras de calle o CP
      let addrLine = lines.find(L => looksLikeAddress(L)) || "";
      // Si no está el CP en esa línea, intenta añadir la línea siguiente que tenga 5 dígitos
      const cpLine = lines.find(L => /\b\d{5}\b/.test(L));
      if (cpLine && !addrLine.includes(cpLine)) addrLine = addrLine ? `${addrLine}, ${cpLine}` : cpLine;

      if (!addrLine) {
        alert("No pude extraer una dirección clara. Rellena a mano o vuelve a intentar con otra foto.");
        setName(probableName);
        return;
      }
      setName(probableName);
      setAddr(addrLine);
      setPhoto(p.webPath || "");
    } catch (e) {
      alert("No se pudo hacer OCR. Revisa permisos de cámara/almacenamiento.");
    }
  }

  function optimize() {
    if (!originLL || list.length<2) return;
    const rem=[...list], out=[]; let cur=originLL;
    while(rem.length){
      let iBest=0, dBest=Infinity;
      rem.forEach((it,i)=>{
        const d = haversine([cur.lat,cur.lon],[it.lat,it.lon]);
        if (d<dBest){ dBest=d; iBest=i; }
      });
      const next = rem.splice(iBest,1)[0];
      out.push(next);
      cur = { lat: next.lat, lon: next.lon };
    }
    setList(out);
  }

  function openMaps(){
    if (!originLL || list.length===0) return;
    const MAX=9, stops=list.slice(0,Math.min(list.length,MAX));
    const originParam=`${originLL.lat},${originLL.lon}`;
    const dest=stops[stops.length-1];
    const destParam=`${dest.lat},${dest.lon}`;
    const way = stops.slice(0,-1).map(p=>`${p.lat},${p.lon}`).join("|");
    const wp = way? `&waypoints=${encodeURIComponent(way)}`:"";
    const url=`https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(originParam)}&destination=${encodeURIComponent(destParam)}${wp}`;
    window.open(url,"_blank");
  }

  return (
    <div style={st.page}>
      <h1 style={{margin:0}}>Tony Rutas (Capacitor)</h1>
      <div style={{color:"#6b7280"}}>Origen + paquetes, <b>fotos</b>, <b>notas</b>, escáner <b>QR/código de barras</b> y OCR.</div>

      <div style={st.card}>
        <div style={{display:"flex", gap:8, marginBottom:8}}>
          <input style={st.input} placeholder="Dirección del almacén / salida"
            value={originText} onChange={e=>setOriginText(e.target.value)} />
          <button style={st.btnPrimary} onClick={setOrigin} disabled={busy}>Definir Origen</button>
        </div>
        <div style={{display:"flex", gap:8}}>
          <input style={st.input} placeholder="Ciudad/CP por defecto (fallback geocoder)"
            value={defaultCity} onChange={e=>setDefaultCity(e.target.value)} />
        </div>
      </div>

      <div style={st.card}>
        <h3 style={{marginTop:0}}>Añadir paquete</h3>
        <input style={st.input} placeholder="Nombre / Seguimiento" value={name} onChange={e=>setName(e.target.value)} />
        <div style={{display:"flex", gap:8, marginTop:8}}>
          <input style={st.input} placeholder="Dirección completa" value={addr} onChange={e=>setAddr(e.target.value)} />
        </div>
        <textarea style={{...st.input, height:72, marginTop:8}} placeholder="Nota (opcional)" value={note} onChange={e=>setNote(e.target.value)} />
        <div style={{display:"flex", gap:8, marginTop:8, flexWrap:"wrap"}}>
          <button style={st.btnPrimary} onClick={addItem} disabled={busy}>Añadir</button>
          <button style={st.btn} onClick={scanCode}>📷 Escanear QR / código</button>
          <button style={st.btn} onClick={ocrFromPhoto}>📸 Leer datos desde foto (OCR)</button>
          <button style={st.btnGhost} onClick={()=>{setName("");setAddr("");setNote("");setPhoto("");}}>Vaciar campos</button>
        </div>
        {photo && <img alt="prev" src={photo} style={{marginTop:8, width:120, height:120, objectFit:"cover", borderRadius:12, border:"1px solid #e5e7eb"}}/>}
      </div>

      <div style={st.card}>
        <div style={{display:"flex", gap:8, flexWrap:"wrap"}}>
          <button style={st.btnPrimary} onClick={openMaps} disabled={!originLL || list.length===0}>🚀 Abrir en Google Maps</button>
          <button style={st.btn} onClick={optimize} disabled={!originLL || list.length<2}>⚡ Optimizar orden</button>
          <button style={st.btnGhost} onClick={()=>setList([])} disabled={list.length===0}>Deshacer</button>
        </div>
        <div style={{marginTop:8}}>Distancia estimada: <b>{km} km</b></div>
      </div>

      <div style={st.card}>
        <h3 style={{marginTop:0}}>Paquetes ({list.length})</h3>
        {list.length===0 ? <div style={{color:"#6b7280"}}>Sin paquetes.</div> : (
          <div style={{display:"grid", gap:8}}>
            {list.map((it, i)=>(
              <div key={it.id} style={st.item}>
                <div style={{flex:1}}>
                  <div style={{fontWeight:700}}>{i+1}. {it.name}</div>
                  <div>{it.address}</div>
                  <div style={{fontSize:12, color:"#6b7280"}}>{it.displayName}</div>
                  {it.note && <div style={{fontStyle:"italic", color:"#4b5563"}}>📝 {it.note}</div>}
                </div>
                {it.photo && <img alt="" src={it.photo} style={{width:56, height:56, borderRadius:10, objectFit:"cover", border:"1px solid #e5e7eb"}}/>}
              </div>
            ))}
          </div>
        )}
      </div>

      {scanning && <WebScanner onCancel={()=>setScanning(false)} onResult={onWebScanResult} />}
    </div>
  );
}

/* ====== Estilos ====== */
const st = {
  page: { maxWidth:900, margin:"0 auto", padding:16 },
  card: { background:"#fff", border:"1px solid #e5e7eb", borderRadius:16, padding:16, marginTop:12 },
  input:{ flex:1, border:"1px solid #d1d5db", borderRadius:10, padding:"10px 12px", outline:"none" },
  btnPrimary:{ background:"#2563eb", color:"#fff", border:"none", borderRadius:10, padding:"10px 14px", cursor:"pointer" },
  btn:{ background:"#f3f4f6", color:"#111827", border:"1px solid #e5e7eb", borderRadius:10, padding:"10px 14px", cursor:"pointer" },
  btnGhost:{ background:"transparent", color:"#2563eb", border:"1px solid #bfdbfe", borderRadius:10, padding:"10px 14px", cursor:"pointer" },
  item:{ display:"flex", alignItems:"center", gap:12, border:"1px solid #e5e7eb", borderRadius:12, padding:12 },

  overlay:{ position:"fixed", inset:0, background:"rgba(0,0,0,0.85)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:9999, padding:12 },
  scanBox:{ position:"relative", width:"min(100%, 720px)", aspectRatio:"16/9", background:"#000", borderRadius:16, overflow:"hidden", border:"1px solid #334155" },
  video:{ width:"100%", height:"100%", objectFit:"cover" },
  frame:{ position:"absolute", inset:"10%", border:"3px solid rgba(255,255,255,0.9)", borderRadius:16, boxShadow:"0 0 0 100vmax rgba(0,0,0,0.25) inset" },
  close:{ position:"absolute", right:12, bottom:12, background:"#111827", color:"#fff", border:"1px solid #374151", borderRadius:10, padding:"10px 12px", cursor:"pointer" },
};
