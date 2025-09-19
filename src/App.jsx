import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Html5QrcodeScanner } from 'html5-qrcode'
import { QRCodeCanvas } from 'qrcode.react'
import { v4 as uuidv4 } from 'uuid'

const now = () => Date.now()
const LS_KEY = 'delivery-packages-v1'
const useLocalStorage = (key, initial) => {
  const [state, setState] = useState(() => {
    try { return JSON.parse(localStorage.getItem(key)) ?? initial } catch { return initial }
  })
  useEffect(()=>{ try{ localStorage.setItem(key, JSON.stringify(state)) }catch{} },[state])
  return [state, setState]
}

const haversine = (a,b)=>{
  const R=6371
  const dLat=(b.lat-a.lat)*Math.PI/180, dLon=(b.lon-a.lon)*Math.PI/180
  const lat1=a.lat*Math.PI/180, lat2=b.lat*Math.PI/180
  const s=Math.sin(dLat/2)**2 + Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLon/2)**2
  return 2*R*Math.asin(Math.sqrt(s))
}
const nearestNeighbor=(start,points)=>{
  const u=points.slice(); const route=[]; let cur=start
  while(u.length){ let bi=0,bd=Infinity; for(let i=0;i<u.length;i++){const d=haversine(cur,u[i]); if(d<bd){bd=d; bi=i}} const nx=u.splice(bi,1)[0]; route.push(nx); cur=nx }
  return route
}
const twoOpt=(route,start)=>{
  const pts=[start,...route]; let improved=true
  while(improved){ improved=false
    for(let i=1;i<pts.length-2;i++){ for(let k=i+1;k<pts.length-1;k++){
      const a=pts[i], b=pts[i+1], c=pts[k], d=pts[k+1]
      const delta=(haversine(a,c)+haversine(b,d))-(haversine(a,b)+haversine(c,d))
      if(delta<-0.001){ const rev=pts.slice(i+1,k+1).reverse(); pts.splice(i+1,k-i,...rev); improved=true }
    }}
  }
  return pts.slice(1)
}
async function geocodeAddress(q){
  const url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&q=' + encodeURIComponent(q);
  const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if (!res.ok) throw new Error('Error geocoding');
  const data = await res.json();
  if (!Array.isArray(data) || data.length === 0) throw new Error('Sin resultados');
  const hit = data[0];
  return { lat: parseFloat(hit.lat), lon: parseFloat(hit.lon), displayName: hit.display_name };
}
function googleMapsDirLink(origin, stops){
  const originParam=`${origin.lat},${origin.lon}`
  const dest=stops[stops.length-1]
  const destinationParam=`${dest.lat},${dest.lon}`
  const waypoints=stops.slice(0,-1).map(p=>`${p.lat},${p.lon}`).join('|')
  const wpParam=waypoints?`&waypoints=${encodeURIComponent(waypoints)}`:''
  return `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(originParam)}&destination=${encodeURIComponent(destinationParam)}${wpParam}`
}

function PackageForm({ onAdd }){
  const [title,setTitle]=useState('')
  const [address,setAddress]=useState('')
  const [qr,setQr]=useState('')
  const [notes,setNotes]=useState('')
  const [priority,setPriority]=useState('normal')
  const [photoDataUrl,setPhotoDataUrl]=useState('')

  const onPhoto=async (e)=>{
    const file=e.target.files?.[0]; if(!file) return
    const reader=new FileReader(); reader.onload=()=>setPhotoDataUrl(reader.result?.toString()||''); reader.readAsDataURL(file)
  }
  const submit=()=>{
    if(!title && !address && !qr) return
    onAdd({ id: uuidv4(), title: title||undefined, address: address||undefined, qr: qr||undefined, notes: notes||undefined, photoDataUrl: photoDataUrl||undefined, priority, status:'pendiente', createdAt: now() })
    setTitle(''); setAddress(''); setQr(''); setNotes(''); setPhotoDataUrl(''); setPriority('normal')
  }
  return (
    <div className="card">
      <h3 style={{marginTop:0}}>Nuevo paquete</h3>
      <div className="grid">
        <input value={title} onChange={e=>setTitle(e.target.value)} placeholder="Nombre/Identificador" />
        <input value={address} onChange={e=>setAddress(e.target.value)} placeholder="Dirección (Calle, nº, ciudad)" />
        <input value={qr} onChange={e=>setQr(e.target.value)} placeholder="Código/Contenido QR (opcional)" />
        <textarea value={notes} onChange={e=>setNotes(e.target.value)} placeholder="Notas (piso, puerta, franja, etc.)"></textarea>
        <div className="row">
          <label>Prioridad</label>
          <select value={priority} onChange={e=>setPriority(e.target.value)}>
            <option value="baja">Baja</option>
            <option value="normal">Normal</option>
            <option value="alta">Alta</option>
          </select>
          <div className="spacer"></div>
          <label className="row" style={{border:'1px solid #cbd5e1',borderRadius:10,padding:'6px 10px',cursor:'pointer'}}>
            📷 Subir foto
            <input type="file" accept="image/*" capture="environment" style={{display:'none'}} onChange={onPhoto} />
          </label>
        </div>
        {photoDataUrl && <img src={photoDataUrl} alt="Foto paquete" style={{maxHeight:220,objectFit:'contain'}} />}
        <button className="btn" onClick={submit}>Añadir paquete</button>
      </div>
    </div>
  )
}

function PackageCard({ item, onToggleStatus, onDelete }){
  return (
    <div className="card">
      <div className="row" style={{justifyContent:'space-between'}}>
        <div className="row">
          {item.status==='entregado' ? <span>✅</span> : <span>○</span>}
          <strong>{item.title || item.qr || '(sin título)'}</strong>
        </div>
        <span className="badge">{item.priority || 'normal'}</span>
      </div>
      {item.address && <div className="row" style={{fontSize:12,opacity:.8}}>📍 {item.address}</div>}
      {item.qr && <div style={{fontSize:12,opacity:.6}}>QR: {item.qr}</div>}
      {item.notes && <div style={{whiteSpace:'pre-wrap'}}>{item.notes}</div>}
      {item.photoDataUrl && <img src={item.photoDataUrl} alt="Foto" style={{maxHeight:240,objectFit:'contain'}} />}
      <div style={{marginTop:8}}>
        <label className="text-xs">Etiqueta QR</label>
        <div style={{display:'inline-block',border:'1px solid #e5e7eb',padding:10,borderRadius:10}}>
          <QRCodeCanvas value={item.qr || item.title || item.address || item.id} size={128}/>
        </div>
      </div>
      <div className="row" style={{marginTop:10,justifyContent:'flex-end'}}>
        <button className="btn outline" onClick={()=>onToggleStatus(item.id)}>
          {item.status==='entregado'?'Marcar pendiente':'Marcar entregado'}
        </button>
        <button className="btn outline" onClick={()=>onDelete(item.id)}>🗑️ Eliminar</button>
      </div>
    </div>
  )
}

function Scanner({ onDetect }){
  const elRef = useRef(null)
  const scannerRef = useRef(null)
  const [running,setRunning] = useState(false)
  useEffect(()=>{
    if(!elRef.current) return
    if(!running) return
    const scanner = new Html5QrcodeScanner(elRef.current.id, { fps: 10, qrbox: 240 }, false)
    scannerRef.current = scanner
    scanner.render((text)=>{ onDetect(text) }, (err)=>{ console.debug('QR error',err) })
    return ()=>{ try{ scanner.clear() }catch{} }
  },[running])
  return (
    <div className="grid">
      <div className="row">
        <button className="btn" onClick={()=>setRunning(true)} disabled={running}>▶️ Iniciar escáner</button>
        <button className="btn outline" onClick={()=>{ setRunning(false); try{ scannerRef.current?.clear() }catch{} }}>Detener</button>
      </div>
      <div id="qr-reader"></div>
      <p style={{fontSize:12,opacity:.7}}>Sugerencia: enfoca la etiqueta/QR del paquete. Cada lectura se añade a la lista.</p>
    </div>
  )
}

const googleMapsDirLink=(origin,stops)=>{
  const originParam=`${origin.lat},${origin.lon}`
  const dest=stops[stops.length-1]
  const destinationParam=`${dest.lat},${dest.lon}`
  const waypoints=stops.slice(0,-1).map(p=>`${p.lat},${p.lon}`).join('|')
  const wpParam=waypoints?`&waypoints=${encodeURIComponent(waypoints)}`:''
  return `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(originParam)}&destination=${encodeURIComponent(destinationParam)}${wpParam}`
}

function RoutePlanner({ items, onItemsUpdate }){
  const [origin,setOrigin]=useState({ lat:null, lon:null, label:'' })
  const [working,setWorking]=useState(false)
  const [result,setResult]=useState([])
  const [useHighPriorityFirst,setUseHighPriorityFirst]=useState(true)

  const geocodeMissing = async ()=>{
    const toGeocode = items.filter(p=>!p.lat && !p.lon && p.address)
    for(let i=0;i<toGeocode.length;i++){
      const p=toGeocode[i]
      try{
        const g=await geocodeAddress(p.address)
        Object.assign(p,{lat:g.lat,lon:g.lon})
        onItemsUpdate(items.map(it=>it.id===p.id?p:it))
        await new Promise(r=>setTimeout(r,1200))
      }catch(e){ console.warn('Geocode fallo', p.address, e) }
    }
  }
  const locateMe = ()=>{
    if(!navigator.geolocation) return alert('Geolocalización no soportada')
    navigator.geolocation.getCurrentPosition(pos=>{
      const { latitude, longitude } = pos.coords
      setOrigin({ lat: latitude, lon: longitude, label: 'Mi ubicación' })
    }, err=>alert('No se pudo obtener ubicación: '+err.message))
  }
  const optimize = async ()=>{
    if(!origin.lat || !origin.lon) return alert('Define un origen')
    setWorking(true)
    try{
      const pts=items.filter(p=>p.lat && p.lon && p.status!=='entregado')
      if(pts.length===0){ setResult([]); return }
      const start={ lat: origin.lat, lon: origin.lon }
      const sorted = useHighPriorityFirst ? pts.sort((a,b)=>(b.priority==='alta')-(a.priority==='alta')) : pts
      const nn=nearestNeighbor(start,sorted)
      const opt=twoOpt(nn,start)
      setResult(opt)
    } finally { setWorking(false) }
  }
  const setOriginByAddress = async ()=>{
    const q=prompt('Introduce dirección de origen (almacén/punto de partida)')
    if(!q) return
    try{ const g=await geocodeAddress(q); setOrigin({ lat:g.lat, lon:g.lon, label:q }) }catch(e){ alert('No se pudo geocodificar esa dirección') }
  }
  const mapsLink = useMemo(()=>{
    if(!origin.lat || result.length===0) return null
    return googleMapsDirLink({ lat: origin.lat, lon: origin.lon }, result)
  },[origin,result])

  return (
    <div className="card grid">
      <h3 style={{marginTop:0}}>Planificación de ruta</h3>
      <div className="row">
        <button className="btn outline" onClick={locateMe}>📍 Usar mi ubicación</button>
        <button className="btn outline" onClick={setOriginByAddress}>Definir origen por dirección</button>
        <button className="btn" onClick={geocodeMissing}>Geocodificar direcciones pendientes</button>
        <div className="spacer"></div>
        <label className="row" style={{fontSize:12}}>
          Priorizar "alta"
          <input type="checkbox" style={{marginLeft:6}} checked={useHighPriorityFirst} onChange={e=>setUseHighPriorityFirst(e.target.checked)} />
        </label>
      </div>
      {origin.lat && <div style={{fontSize:12,opacity:.7}}>Origen: {origin.label || `${origin.lat?.toFixed(5)}, ${origin.lon?.toFixed(5)}`}</div>}
      <button className="btn" onClick={optimize}>{working?'Calculando...':'Optimizar ruta'}</button>
      {result.length>0 && (
        <div className="grid">
          <div>Paradas sugeridas ({result.length}):</div>
          <ol>
            {result.map(p=>(
              <li key={p.id}>
                <div className="row" style={{justifyContent:'space-between'}}>
                  <div>
                    <div style={{fontWeight:600}}>{p.title || p.qr || p.address || p.id}</div>
                    <div style={{fontSize:12,opacity:.7}}>{p.address} {p.priority? `· ${p.priority}`: ''}</div>
                  </div>
                  <a href={`https://www.google.com/maps/search/?api=1&query=${p.lat},${p.lon}`} target="_blank" rel="noreferrer">Abrir en Maps</a>
                </div>
              </li>
            ))}
          </ol>
          {mapsLink && <a className="btn" href={mapsLink} target="_blank" rel="noreferrer">Abrir ruta completa en Google Maps</a>}
        </div>
      )}
    </div>
  )
}

export default function App(){
  const [items,setItems] = useLocalStorage(LS_KEY, [])
  const [search,setSearch] = useState('')
  useEffect(()=>{
    const input = document.getElementById('search')
    if(input){ input.value = search; input.oninput = (e)=>setSearch(e.target.value) }
  },[search])

  const onAdd = (p)=>setItems([p,...items])
  const onToggleStatus = (id)=>setItems(items.map(it=>it.id===id?{...it, status: it.status==='entregado'?'pendiente':'entregado'}:it))
  const onDelete = (id)=>setItems(items.filter(it=>it.id!==id))
  const filtered = useMemo(()=>{
    if(!search) return items
    const q=search.toLowerCase()
    return items.filter(p=>(p.title||'').toLowerCase().includes(q) || (p.address||'').toLowerCase().includes(q) || (p.qr||'').toLowerCase().includes(q))
  },[items,search])
  const pending = filtered.filter(p=>p.status!=='entregado')
  const delivered = filtered.filter(p=>p.status==='entregado')

  const exportJSON=()=>{
    const blob=new Blob([JSON.stringify(items,null,2)],{type:'application/json'})
    const url=URL.createObjectURL(blob); const a=document.createElement('a'); a.href=url; a.download='paquetes.json'; a.click(); URL.revokeObjectURL(url)
  }
  const exportCSV=()=>{
    const headers=['id','title','address','lat','lon','qr','priority','status','notes','createdAt']
    const rows=items.map(p=>headers.map(h=>JSON.stringify(p[h]??'')).join(',')).join('\n')
    const csv=headers.join(',')+'\n'+rows
    const blob=new Blob([csv],{type:'text/csv'})
    const url=URL.createObjectURL(blob); const a=document.createElement('a'); a.href=url; a.download='paquetes.csv'; a.click(); URL.revokeObjectURL(url)
  }
  const importJSON=(e)=>{
    const file=e.target.files?.[0]; if(!file) return
    const reader=new FileReader(); reader.onload=()=>{ try{ const data=JSON.parse(reader.result); if(Array.isArray(data)) setItems(data) }catch{ alert('Archivo inválido') } }; reader.readAsText(file)
  }

  return (
    <div>
      <div className="container grid">
        <div className="grid grid-2">
          <PackageForm onAdd={onAdd} />
          <div className="card">
            <h3 style={{marginTop:0}}>Escanear QR</h3>
            <Scanner onDetect={(text)=>{ const pkg={ id: uuidv4(), qr: text, createdAt: now(), status:'pendiente', priority: 'normal' }; setItems([pkg,...items]) }} />
            <div className="row" style={{marginTop:10}}>
              <button className="btn" onClick={exportJSON}>Exportar JSON</button>
              <button className="btn outline" onClick={exportCSV}>Exportar CSV</button>
              <label className="btn outline" style={{display:'inline-flex',alignItems:'center',gap:8,cursor:'pointer'}}>
                Importar JSON
                <input type="file" accept="application/json" style={{display:'none'}} onChange={importJSON}/>
              </label>
            </div>
          </div>
        </div>

        <div className="grid">
          <h2 style={{marginBottom:0}}>Paquetes pendientes</h2>
          <div className="grid" style={{gridTemplateColumns:'repeat(auto-fill,minmax(260px,1fr))'}}>
            {pending.map(p=>(<PackageCard key={p.id} item={p} onToggleStatus={onToggleStatus} onDelete={onDelete} />))}
          </div>
          {delivered.length>0 && <>
            <h3 style={{opacity:.7}}>Entregados</h3>
            <div className="grid" style={{gridTemplateColumns:'repeat(auto-fill,minmax(260px,1fr))'}}>
              {delivered.map(p=>(<PackageCard key={p.id} item={p} onToggleStatus={onToggleStatus} onDelete={onDelete} />))}
            </div>
          </>}
        </div>

        <div className="grid">
          <RoutePlanner items={items} onItemsUpdate={setItems} />
        </div>

        <footer style={{textAlign:'center',fontSize:12,opacity:.6,padding:'16px 0'}}>Hecho con ❤️ · Capacitor · Datos locales</footer>
      </div>
    </div>
  )
}
