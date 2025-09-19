import React, { useEffect, useMemo, useRef, useState } from 'react'

/** =====================
 *  Utils
 *  ===================== */
const LS_ITEMS = 'tr_items_v2'
const LS_ORIGIN = 'tr_origin_v2'

const now = () => Date.now()

// Haversine distance in km
function haversine(a, b){
  const R=6371
  const dLat=(b.lat-a.lat)*Math.PI/180
  const dLon=(b.lon-a.lon)*Math.PI/180
  const lat1=a.lat*Math.PI/180, lat2=b.lat*Math.PI/180
  const s=Math.sin(dLat/2)**2 + Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLon/2)**2
  return 2*R*Math.asin(Math.sqrt(s))
}

// Greedy nearest-neighbor heuristic
function nearestNeighbor(start, points){
  const U = points.slice()
  const route = []
  let cur = start
  while (U.length){
    let best = 0, bestD = Infinity
    for (let i=0;i<U.length;i++){
      const d = haversine(cur, U[i])
      if (d < bestD){ bestD = d; best = i }
    }
    const nx = U.splice(best,1)[0]
    route.push(nx)
    cur = nx
  }
  return route
}

// 2-opt refinement
function twoOpt(route, start){
  const pts = [start, ...route]
  let improved = true
  while (improved){
    improved = false // will fix JS boolean
  }
  return route
}

// Proper 2-opt
function improveTwoOpt(route, start){
  const pts = [start, ...route]
  let improved = true
  while (improved){
    improved = false
    for (let i=1; i<pts.length-2; i++){
      for (let k=i+1; k<pts.length-1; k++){
        const a=pts[i], b=pts[i+1], c=pts[k], d=pts[k+1]
        const delta=(haversine(a,c)+haversine(b,d))-(haversine(a,b)+haversine(c,d))
        if (delta < -0.0001){
          const rev = pts.slice(i+1, k+1).reverse()
          pts.splice(i+1, k-i, ...rev)
          improved = true
        }
      }
    }
  }
  return pts.slice(1)
}

// Chunk array into parts of size n
function chunk(arr, n){
  const out=[]; for(let i=0;i<arr.length;i+=n){ out.push(arr.slice(i,i+n)) } return out
}

// Google Maps link builder (with lat,lon waypoints)
function mapsLink(origin, stops){
  const originParam = origin.lat + ',' + origin.lon
  const dest = stops[stops.length-1]
  const destinationParam = dest.lat + ',' + dest.lon
  const waypoints = stops.slice(0, -1).map(p => p.lat + ',' + p.lon).join('|')
  const wp = waypoints ? '&waypoints=' + encodeURIComponent(waypoints) : ''
  return 'https://www.google.com/maps/dir/?api=1&origin=' + encodeURIComponent(originParam) +
         '&destination=' + encodeURIComponent(destinationParam) + wp
}

// Geocode via OpenStreetMap
async function geocodeAddress(q){
  const url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&q=' + encodeURIComponent(q)
  const res = await fetch(url, { headers: { 'Accept': 'application/json' } })
  if(!res.ok) throw new Error('geo error')
  const data = await res.json()
  if(!Array.isArray(data) || data.length===0) throw new Error('no hits')
  const hit = data[0]
  return { lat: parseFloat(hit.lat), lon: parseFloat(hit.lon), displayName: hit.display_name }
}

/** =====================
 *  Components
 *  ===================== */
function PackageForm({ onAdd }){
  const [title,setTitle]=useState('')
  const [address,setAddress]=useState('')
  const [priority,setPriority]=useState('normal')
  const [notes,setNotes]=useState('')
  const [photo,setPhoto]=useState('')

  const onPickPhoto = (e)=>{
    const file = e.target.files?.[0]; if(!file) return
    const reader = new FileReader()
    reader.onload = () => setPhoto(reader.result?.toString() || '')
    reader.readAsDataURL(file)
  }

  const submit = async (e)=>{
    e.preventDefault()
    if(!address && !title) return
    try {
      const g = await geocodeAddress(address)
      onAdd({ id: Date.now().toString(36), title, address, lat:g.lat, lon:g.lon, displayName:g.displayName, priority, notes, photo, status:'pendiente', createdAt: now() })
      setTitle(''); setAddress(''); setPriority('normal'); setNotes(''); setPhoto('')
    } catch {
      alert('No pude geocodificar esa dirección. Prueba con ciudad/CP.')
    }
  }

  return (
    <form onSubmit={submit} className="card grid">
      <h3 style={{margin:0}}>Añadir paquete</h3>
      <input placeholder="Nombre/Identificador" value={title} onChange={e=>setTitle(e.target.value)} />
      <input placeholder="Dirección completa" value={address} onChange={e=>setAddress(e.target.value)} />
      <div style={{display:'flex',gap:8,flexWrap:'wrap'}}>
        <select value={priority} onChange={e=>setPriority(e.target.value)}>
          <option value="baja">Baja</option>
          <option value="normal">Normal</option>
          <option value="alta">Alta</option>
        </select>
        <label style={{border:'1px solid #2b2b2b',borderRadius:8,padding:'8px',cursor:'pointer'}}>
          📷 Foto
          <input type="file" accept="image/*" capture="environment" style={{display:'none'}} onChange={onPickPhoto} />
        </label>
      </div>
      <textarea placeholder="Notas (piso, franja, contacto…)" value={notes} onChange={e=>setNotes(e.target.value)} rows={3} />
      {photo && <img alt="foto" src={photo} style={{maxHeight:180,objectFit:'contain',borderRadius:8}} />}
      <div style={{display:'flex',gap:8,justifyContent:'flex-end'}}>
        <button className="btn" type="submit">Añadir</button>
      </div>
    </form>
  )
}

function ItemCard({ it, onToggle, onDelete }){
  return (
    <div className="item">
      <div style={{flex:1}}>
        <div style={{display:'flex',justifyContent:'space-between',gap:8,alignItems:'center'}}>
          <strong>{it.title || it.address}</strong>
          <span className="pill">{it.priority || 'normal'}</span>
        </div>
        <div className="muted" style={{marginTop:4}}>{it.displayName || it.address}</div>
        {it.notes && <div className="muted" style={{marginTop:6,whiteSpace:'pre-wrap'}}>{it.notes}</div>}
        {it.photo && <img alt="foto" src={it.photo} style={{marginTop:8,maxHeight:180,objectFit:'contain',borderRadius:8}} />}
      </div>
      <div style={{display:'grid',gap:6}}>
        <button className="btn ghost" onClick={()=>onToggle(it.id)}>{it.status==='entregado'?'↩️ Pendiente':'✅ Entregado'}</button>
        <button className="btn danger" onClick={()=>onDelete(it.id)}>🗑️ Eliminar</button>
      </div>
    </div>
  )
}

export default function App(){
  const [items,setItems] = useState(()=>{ try{ return JSON.parse(localStorage.getItem(LS_ITEMS)) ?? [] }catch{ return [] } })
  const [origin,setOrigin] = useState(()=>{ try{ return JSON.parse(localStorage.getItem(LS_ORIGIN)) ?? null }catch{ return null } })
  const [usePriority,setUsePriority]=useState(true)
  const [optim,setOptim]=useState([])

  useEffect(()=>{ try{ localStorage.setItem(LS_ITEMS, JSON.stringify(items)) }catch{} },[items])
  useEffect(()=>{ try{ localStorage.setItem(LS_ORIGIN, JSON.stringify(origin)) }catch{} },[origin])

  const pending = useMemo(()=>items.filter(p=>p.status!=='entregado'),[items])
  const delivered = useMemo(()=>items.filter(p=>p.status==='entregado'),[items])

  // Import/Export
  const exportJSON = ()=>{
    const blob = new Blob([JSON.stringify(items,null,2)],{type:'application/json'})
    const url = URL.createObjectURL(blob); const a=document.createElement('a'); a.href=url; a.download='paquetes.json'; a.click(); URL.revokeObjectURL(url)
  }
  const exportCSV = ()=>{
    const headers=['id','title','address','lat','lon','priority','status','notes','createdAt']
    const rows=items.map(p=>headers.map(h=>JSON.stringify(p[h]??'')).join(',')).join('\n')
    const csv=headers.join(',')+'\n'+rows
    const blob=new Blob([csv],{type:'text/csv'})
    const url=URL.createObjectURL(blob); const a=document.createElement('a'); a.href=url; a.download='paquetes.csv'; a.click(); URL.revokeObjectURL(url)
  }
  const importJSON = (e)=>{
    const f=e.target.files?.[0]; if(!f) return
    const r=new FileReader(); r.onload=()=>{ try{ const d=JSON.parse(r.result); if(Array.isArray(d)) setItems(d) }catch{ alert('Archivo inválido') } }; r.readAsText(f)
  }

  const locateOrigin = ()=>{
    if(!navigator.geolocation){ alert('Geolocalización no disponible'); return }
    navigator.geolocation.getCurrentPosition(pos=>{
      setOrigin({ lat: pos.coords.latitude, lon: pos.coords.longitude, displayName: 'Mi ubicación' })
    }, err=>alert('No se pudo obtener ubicación: '+err.message))
  }

  const setOriginByAddress = async ()=>{
    const q = prompt('Dirección de origen')
    if(!q) return
    try{ const g=await geocodeAddress(q); setOrigin({ lat:g.lat, lon:g.lon, displayName:q }) }catch{ alert('No se pudo geocodificar esa dirección') }
  }

  const optimize = ()=>{
    if(!origin){ alert('Define un origen'); return }
    const pts=pending.filter(p=>p.lat && p.lon)
    if(pts.length===0){ setOptim([]); return }
    const start={ lat: origin.lat, lon: origin.lon }
    const base = usePriority ? pts.slice().sort((a,b)=>(b.priority==='alta')-(a.priority==='alta')) : pts
    const nn = nearestNeighbor(start, base)
    const two = improveTwoOpt(nn, start)
    setOptim(two)
  }

  const openMaps = ()=>{
    if(!origin){ alert('Define un origen'); return }
    const stops = (optim.length>0? optim : pending).filter(p=>p.lat&&p.lon)
    if(stops.length===0){ alert('No hay paradas geocodificadas'); return }
    // Google Maps supports ~9 waypoints; chunk if needed
    const batches = chunk(stops, 9)
    batches.forEach((batch, idx)=>{
      const link = mapsLink({ lat: origin.lat, lon: origin.lon }, batch)
      // open each in a new tab so driver can ir por bloques
      setTimeout(()=>window.open(link, '_blank'), idx*300)
    })
  }

  const onAdd = (p)=>setItems([p, ...items])
  const onToggle = (id)=>setItems(items.map(it=>it.id===id?{...it, status: it.status==='entregado'?'pendiente':'entregado'}:it))
  const onDelete = (id)=>setItems(items.filter(it=>it.id!==id))

  return (
    <div className="container">
      <header className="row" style={{gap:12, marginBottom:12}}>
        <h2 style={{margin:0}}>📦 Tony Rutas Pro</h2>
        <span className="pill">{origin? ('Origen: ' + (origin.displayName || (origin.lat.toFixed(5)+', '+origin.lon.toFixed(5)))) : 'Origen: no definido'}</span>
        <div className="spacer" />
        <button className="btn ghost" onClick={exportCSV}>Exportar CSV</button>
        <button className="btn ghost" onClick={exportJSON}>Exportar JSON</button>
        <label className="btn ghost" style={{cursor:'pointer'}}>
          Importar JSON
          <input type="file" accept="application/json" style={{display:'none'}} onChange={importJSON} />
        </label>
      </header>

      <div className="grid grid-2">
        <PackageForm onAdd={onAdd} />
        <div className="card grid">
          <h3 style={{margin:0}}>Origen y ruta</h3>
          <div className="row" style={{gap:8, flexWrap:'wrap'}}>
            <button className="btn" onClick={locateOrigin}>📍 Usar mi ubicación</button>
            <button className="btn" onClick={setOriginByAddress}>Definir origen por dirección</button>
            <label className="row" style={{fontSize:12, gap:8}}>
              Priorizar alta
              <input type="checkbox" checked={usePriority} onChange={e=>setUsePriority(e.target.checked)} />
            </label>
          </div>
          <div className="row" style={{gap:8, flexWrap:'wrap'}}>
            <button className="btn" onClick={optimize}>⚡ Optimizar</button>
            <button className="btn ghost" onClick={openMaps}>🚀 Abrir en Google Maps</button>
          </div>
          {optim.length>0 && <div className="muted">Paradas optimizadas: {optim.length}</div>}
        </div>
      </div>

      <section className="card">
        <h3 style={{marginTop:0}}>Pendientes</h3>
        <div className="list">
          {pending.map(it => <ItemCard key={it.id} it={it} onToggle={onToggle} onDelete={onDelete} />)}
        </div>
        {pending.length===0 && <div className="muted">Sin pendientes 🎉</div>}
      </section>

      {delivered.length>0 && (
        <section className="card">
          <h3 style={{marginTop:0}}>Entregados</h3>
          <div className="list">
            {delivered.map(it => <ItemCard key={it.id} it={it} onToggle={onToggle} onDelete={onDelete} />)}
          </div>
        </section>
      )}
    </div>
  )
}
