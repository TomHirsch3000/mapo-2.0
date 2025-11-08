// App.js
import React, { useEffect, useMemo, useRef, useState } from "react";
import * as d3 from "d3";
import "./App.css";

/* =============================================================================
   Paper Map — Stable Continuous Zoom with Persistent Depth Separation
   ---------------------------------------------------------------------------
   ✅ X-axis strictly maps to publication year (no horizontal warp)
   ✅ Smooth, cumulative separation with no "jump back" between zoom gestures
   ✅ Curved, depth-weighted Y separation (near nodes peel faster)
   ✅ Hover & click interactions preserved; neighbors raised & labeled
   ✅ Anti-overlap; tooltip; axis rescaling; no gridlines
============================================================================= */

export default function App() {
  /* ---------------------------------- Refs & State ---------------------------------- */
  const svgRef = useRef(null);
  const wrapRef = useRef(null);
  const tooltipRef = useRef(null);

  const [rawNodes, setRawNodes] = useState([]);
  const [rawEdges, setRawEdges] = useState([]);
  const [selected, setSelected] = useState(null);

  // persistent Y-separation (lane-units)
  const sepAccumRef = useRef(new Map()); // id -> laneOffset
  const sessionRef = useRef(null);       // active zoom gesture
  const lockedIdRef = useRef(null);

  /* ---------------------------------- Load Data ---------------------------------- */
  useEffect(() => {
    Promise.all([
      fetch("/nodes.json").then(r => r.json()),
      fetch("/edges.json").then(r => r.json()),
    ])
      .then(([n, e]) => {
        setRawNodes(Array.isArray(n) ? n : []);
        setRawEdges(Array.isArray(e) ? e : []);
      })
      .catch(err => console.error("Failed to load data:", err));
  }, []);

  /* ---------------------------------- Normalize ---------------------------------- */
  const nodes = useMemo(() => {
    return (rawNodes || []).map(d => {
      const yr = d.year ?? d.publication_year ??
        (d.publicationDate ? new Date(d.publicationDate).getFullYear() : undefined);
      const field = d.AI_primary_field || d.field || d.primary_field || "Unassigned";
      const cites = d.citationCount ?? d.cited_by_count ?? 0;
      return {
        ...d,
        id: String(d.id),
        year: Number.isFinite(+yr) ? +yr : undefined,
        field,
        citationCount: Number.isFinite(+cites) ? +cites : 0,
        authors: d.authors || d.authors_text || d.author || undefined,
        url: d.url || d.doi_url || d.openAlexUrl || d.s2Url || undefined,
      };
    });
  }, [rawNodes]);

  const nodeById = useMemo(() => new Map(nodes.map(n => [n.id, n])), [nodes]);

  const edges = useMemo(() => {
    const out = [];
    for (const e of rawEdges || []) {
      const s = nodeById.get(String(e.source));
      const t = nodeById.get(String(e.target));
      if (s && t) out.push({ source: s.id, target: t.id });
    }
    return out;
  }, [rawEdges, nodeById]);

  const edgesByNode = useMemo(() => {
    const m = new Map();
    for (const n of nodes) m.set(n.id, []);
    edges.forEach((e, i) => {
      m.get(e.source)?.push(i);
      m.get(e.target)?.push(i);
    });
    return m;
  }, [nodes, edges]);

  /* ---------------------------------- Lanes, Years, Depth ---------------------------------- */
  const { fields, fieldIndex, yearsDomain, yearsCenter } = useMemo(() => {
    const fields = Array.from(new Set(nodes.map(d => d.field))).sort();
    const fieldIndex = f => Math.max(0, fields.indexOf(f ?? "Unassigned"));
    const years = nodes.map(d => d.year).filter(v => Number.isFinite(v));
    const minYear = years.length ? d3.min(years) : 1950;
    const maxYear = years.length ? d3.max(years) : 2025;
    const low = minYear - 1, high = maxYear + 1;
    return { fields, fieldIndex, yearsDomain: [low, high], yearsCenter: (low + high) / 2 };
  }, [nodes]);

  useEffect(() => {
    const [minC, maxC] = d3.extent(nodes, d => d.citationCount);
    const zScale = d3.scaleLinear().domain([minC ?? 0, maxC ?? 1]).range([0, 1]);
    nodes.forEach(d => { d.z = zScale(d.citationCount); });
  }, [nodes]);

  // base size
  const baseTileSize = useMemo(() => {
    const [minC, maxC] = d3.extent(nodes, d => d.citationCount);
    const s = d3.scaleSqrt().domain([Math.max(1, minC ?? 1), Math.max(2, maxC ?? 2)]).range([12, 54]);
    return d => {
      const base = s(Math.max(1, d.citationCount));
      return { w: base * 1.8, h: base * 1.1, rxBase: 8 };
    };
  }, [nodes]);

  // sync accumulator with nodes
  useEffect(() => {
    const acc = sepAccumRef.current;
    for (const n of nodes) if (!acc.has(n.id)) acc.set(n.id, 0);
    for (const id of Array.from(acc.keys())) if (!nodeById.has(id)) acc.delete(id);
  }, [nodes, nodeById]);

  useEffect(() => { lockedIdRef.current = selected?.id || null; }, [selected]);

  /* ============================================================================
     Main D3 setup
     ========================================================================== */
  useEffect(() => {
    if (!wrapRef.current || !svgRef.current) return;

    const svg = d3.select(svgRef.current);
    svg.selectAll("*").remove();

    const margin = { top: 28, right: 28, bottom: 48, left: 180 };
    const cw = Math.max(600, wrapRef.current.clientWidth || 1200);
    const ch = Math.max(380, wrapRef.current.clientHeight || 750);
    const width = cw - margin.left - margin.right;
    const height = ch - margin.top - margin.bottom;

    svg.attr("width", cw).attr("height", ch).style("background", "#f5f5f7");

    const gRoot = svg.append("g").attr("transform", `translate(${margin.left},${margin.top})`);
    const gPlot = gRoot.append("g").attr("class", "plot");
    const gAxes = gRoot.append("g").attr("class", "axes");

    const x = d3.scaleLinear().domain(yearsDomain).range([0, width]);
    const yLane = d3.scaleLinear().domain([0, Math.max(0, fields.length - 1)]).range([0, height]);
    const color = d3.scaleOrdinal(d3.schemeTableau10).domain(fields);

    // deterministic jitter
    const jitterMaxLaneUnits = 0.35;
    const hash32 = (s) => { let h=2166136261>>>0; for (let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,16777619);}return h>>>0; };
    const hashUnit = (s) => hash32(s)/4294967296;
    const jitterLane = (id) => (hashUnit(String(id))-0.5)*2*jitterMaxLaneUnits;

    // axes (no grid)
    const xAxisG = gAxes.append("g").attr("transform", `translate(0,${height})`);
    const yAxisG = gAxes.append("g");
    xAxisG.call(d3.axisBottom(x).ticks(10).tickFormat(d3.format("d")));
    yAxisG.call(d3.axisLeft(yLane).tickValues(fields.map((_, i)=>i)).tickFormat((i)=>fields[i]));

    // defs for arrow
    const defs = svg.append("defs");
    defs.append("marker")
      .attr("id","arrow-mid").attr("viewBox","0 -5 10 10")
      .attr("refX",5).attr("refY",0)
      .attr("markerWidth",7).attr("markerHeight",7)
      .attr("orient","auto")
      .append("path").attr("d","M0,-5L10,0L0,5").attr("fill","#444");

    // layers
    const edgesG = gPlot.append("g").attr("class","edges");
    const nodesG = gPlot.append("g").attr("class","nodes");
    const edgeData = edges.map((e,i)=>({...e,_i:i}));

    // nodes
    const nodesSel = nodesG.selectAll("g.node")
      .data(nodes, d=>d.id)
      .join(enter=>{
        const g=enter.append("g").attr("class","node").style("cursor","pointer");
        g.append("rect").attr("class","node-rect")
          .attr("stroke","#333").attr("fill",d=>color(d.field))
          .attr("opacity",0.85).attr("vector-effect","non-scaling-stroke");
        g.append("text").attr("class","node-label")
          .attr("text-anchor","middle")
          .style("font-size","11px").style("font-weight",500)
          .style("pointer-events","none").style("fill","#0f0f10")
          .style("opacity",0);
        return g;
      });

    // edges
    const edgesSel = edgesG.selectAll("path.edge")
      .data(edgeData).join("path")
      .attr("class","edge")
      .attr("fill","none").attr("stroke","#aaa")
      .attr("stroke-width",1).attr("opacity",0.35)
      .attr("pointer-events","none").attr("vector-effect","non-scaling-stroke");

    // tooltip
    const showTip = (evt,d)=>{
      const tip=tooltipRef.current; if(!tip)return;
      tip.style.display="block";
      tip.style.left=`${evt.pageX+12}px`;
      tip.style.top=`${evt.pageY+12}px`;
      tip.innerHTML=`
        <strong>${d.title||"Untitled"}</strong><br/>
        ${d.authors?`<span>${d.authors}</span><br/>`:""}
        <em>${d.field}</em> • ${d.year??"n/a"}<br/>
        <strong>Citations:</strong> ${d.citationCount}<br/>
        ${d.url?`<a href="${d.url}" target="_blank" rel="noreferrer">Open source</a>`:""}
      `;
    };
    const hideTip=()=>{const tip=tooltipRef.current;if(tip)tip.style.display="none";};

    // highlight helpers
    const getNeighborSet=(id)=>{
      const idxs=edgesByNode.get(id)||[];
      const s=new Set([id]);
      idxs.forEach(i=>{const e=edgeData[i];s.add(e.source);s.add(e.target);});
      return s;
    };
    const applyDefaultEdgeStyle=()=>{
      edgesSel.attr("stroke","#aaa").attr("opacity",0.35).attr("marker-mid",null);
      nodesSel.selectAll("rect.node-rect")
        .attr("opacity",d=>0.85*(0.6+0.4*(d.z??0.5)))
        .attr("fill",d=>color(d.field)).attr("stroke-width",1.2);
      nodesSel.selectAll("text.node-label").style("opacity",0);
    };
    const dimExceptNeighbors=(id)=>{
      const neigh=getNeighborSet(id);
      nodesSel.selectAll("rect.node-rect").each(function(d){
        const isN=neigh.has(d.id);
        d3.select(this)
          .attr("opacity",isN?0.95:0.12)
          .attr("fill",isN?color(d.field):"#d8d8dc");
      });
    };
    const raiseNeighborhood=(id)=>{
      const idxs=edgesByNode.get(id)||[];
      const neigh=getNeighborSet(id);
      edgesSel.filter(e=>idxs.includes(e._i)).raise();
      nodesSel.filter(d=>neigh.has(d.id)).raise();
      nodesSel.filter(d=>d.id===id).raise();
    };
    const highlightNeighborhood=(id,{dim=false,raise=false}={})=>{
      if(!id){applyDefaultEdgeStyle();return;}
      const idxs=edgesByNode.get(id)||[];
      edgesSel.attr("stroke","#c7c7cc").attr("opacity",0.18).attr("marker-mid",null);
      const hi=edgesSel.filter(e=>idxs.includes(e._i))
        .attr("stroke","#444").attr("opacity",0.95)
        .attr("marker-mid","url(#arrow-mid)");
      nodesSel.selectAll("rect.node-rect").attr("stroke-width",1.2);
      nodesSel.filter(d=>d.id===id).select("rect.node-rect").attr("stroke-width",3);
      if(dim)dimExceptNeighbors(id);
      if(raise){hi.raise();raiseNeighborhood(id);}
    };

    applyDefaultEdgeStyle();

    // label wrapper (top-centered)
    function wrapLabel(d,w){
      const g=nodesSel.filter(n=>n.id===d.id);
      const text=g.select("text.node-label");
      const words=(d.title||"Untitled").split(/\s+/).slice(0,60);
      text.attr("x",w/2).attr("y",8).style("opacity",1).text(null);
      let line=[],lineNumber=0,tspan=text.append("tspan").attr("x",w/2).attr("y",8).attr("dy","0em");
      for(let i=0;i<words.length;i++){
        line.push(words[i]);tspan.text(line.join(" "));
        if(tspan.node().getComputedTextLength()>w*0.86){
          line.pop();tspan.text(line.join(" "));line=[words[i]];lineNumber++;
          if(lineNumber>=3){tspan.text(tspan.text()+"…");break;}
          tspan=text.append("tspan").attr("x",w/2).attr("y",8).attr("dy",`${lineNumber*1.05}em`).text(words[i]);
        }
      }
    }

    /* ------------------------------ Build coeffs per zoom start ------------------------------ */
    function buildCoeffsAt(vpYear,vpLane){
      const lambdaYearsToLanes=(yLane.domain()[1]-yLane.domain()[0])/(x.domain()[1]-x.domain()[0]);
      const diag=Math.hypot(
        (x.domain()[1]-x.domain()[0])*lambdaYearsToLanes,
        (yLane.domain()[1]-yLane.domain()[0])
      )||1;
      const coeffs=new Map();
      const depthGamma=1.9,curveRadialGain=0.45;
      for(const d of nodes){
        const lane0=fieldIndex(d.field)+jitterLane(d.id);
        const dx=( (d.year??yearsDomain[0]) - vpYear )*lambdaYearsToLanes;
        const dy=lane0 - vpLane;
        const r=Math.hypot(dx,dy);
        const rNorm=r/(diag/2);
        const dz=(d.z??0.5)-0.5;
        const depthEase=Math.sign(dz)*Math.pow(Math.abs(dz),depthGamma);
        const radialCurve=1+curveRadialGain*rNorm*rNorm;
        const unitY=r===0?0:(dy/r);
        coeffs.set(d.id, unitY*depthEase*radialCurve);
      }
      return coeffs;
    }

    /* ------------------------------ Zoom setup ------------------------------ */
    const zoom = d3.zoom()
      .scaleExtent([0.5,24])
      .wheelDelta(ev=>{
        const dy=-ev.deltaY,mode=ev.deltaMode,kNow=d3.zoomTransform(svg.node()).k;
        const base=mode===1?0.03:mode===2?0.25:0.0012;
        const slow=1+0.45*Math.max(0,kNow-1);
        const raw=(dy*base)/slow;
        const floor=0.0017+0.0007*Math.sqrt(Math.max(1,kNow));
        return Math.sign(raw)*Math.max(Math.abs(raw),floor);
      })
      .translateExtent([[ -1e7, -1e7 ], [ width+1e7, height+1e7 ]])
      .filter((event) => !(event.ctrlKey && event.type === "wheel"))
      .on("start",(ev)=>{
        const se=ev?.sourceEvent;
        const isScale=se&&(se.type==="wheel"||se.type==="gesturechange"||se.type==="dblclick");
        if(!isScale)return;
        const t=d3.zoomTransform(svg.node());
        const logK0=Math.log(Math.max(1e-6,t.k));
        // VP in DATA space at viewport center (under current transform)
        const invX=t.rescaleX(x),invY=t.rescaleY(yLane);
        const vpYear=invX.invert(width/2),vpLane=invY.invert(height/2);
        sessionRef.current={
          active:true,
          vpYear,vpLane,logK0,
          coeffById:buildCoeffsAt(vpYear,vpLane),
          incNow:0
        };
      })
      .on("zoom",(ev)=>{
        const t=ev.transform;
        const s=sessionRef.current;
        if(s&&s.active){
          const logK=Math.log(Math.max(1e-6,t.k));
          s.incNow=logK-s.logK0; // incremental magnitude since gesture start
        }
        renderWithTransform(t);
      })
      .on("end",()=>{
        const s=sessionRef.current;
        if(!s||!s.active)return;
        // commit incremental into persistent accumulator (lane-units)
        const acc=sepAccumRef.current;
        const sepGain=1.15;
        for(const d of nodes){
          const coeff=s.coeffById.get(d.id)||0;
          const add=sepGain*s.incNow*coeff;
          acc.set(d.id,(acc.get(d.id)||0)+add);
        }
        s.active=false;s.incNow=0;
      });

    svg.call(zoom);
    svg.on("dblclick.zoom",null);

    /* ------------------------------ Renderer ------------------------------ */
    function renderWithTransform(t){
      const k=t.k;
      const newX=t.rescaleX(x);
      const newY=t.rescaleY(yLane);

      const s=sessionRef.current;
      const acc=sepAccumRef.current;
      const sepGain=1.15; // must match zoom end

      const tileFor=(d)=>{
        const base=baseTileSize(d);
        const sizeBoost=0.9+0.4*(d.z??0.5);
        const w=base.w*Math.pow(k,1.06)*sizeBoost;
        const h=base.h*Math.pow(k,1.06)*sizeBoost;
        const rx=Math.min(base.rxBase*Math.pow(k,0.5),Math.max(6,h*0.28));
        return {w,h,rx};
      };

      const incMag=(s&&s.active)?(sepGain*s.incNow):0;

      const projected=nodes.map(d=>{
        const lane0=fieldIndex(d.field)+jitterLane(d.id);
        let lane=lane0+(acc.get(d.id)||0);
        if(s&&s.active){
          const coeff=s.coeffById.get(d.id)||0;
          lane += coeff*incMag; // incremental only during gesture
        }
        const cx =  margin.left + newX(d.year ?? yearsDomain[0]); // X aligned to year
        const cy =  margin.top  + newY(lane);                     // Y with separation
        const {w,h,rx}=tileFor(d);
        return {id:d.id,cx,cy,w,h,rx};
      });

      const P=new Map(projected.map(p=>[p.id,p]));

      // Anti-overlap within lanes (vertical pushes only) at close zoom
      if(k>1.25){
        const laneBuckets=new Map();
        for(const d of nodes){
          const li=fieldIndex(d.field);
          if(!laneBuckets.has(li))laneBuckets.set(li,[]);
          laneBuckets.get(li).push(d.id);
        }
        const minGap=(d)=>Math.max(6, P.get(d.id).h*0.33);
        laneBuckets.forEach(ids=>{
          const arr=ids.map(id=>({id,cx:P.get(id).cx})).sort((a,b)=>a.cx-b.cx);
          for(let i=1;i<arr.length;i++){
            const pa=P.get(arr[i-1].id), pb=P.get(arr[i].id);
            if(!pa||!pb)continue;
            const gapNeeded=Math.max(minGap(nodeById.get(arr[i-1].id)),minGap(nodeById.get(arr[i].id)));
            const overlap = pa.h/2 + pb.h/2 + gapNeeded - Math.abs(pb.cy - pa.cy);
            if(overlap>0){ pa.cy -= overlap/2; pb.cy += overlap/2; }
          }
        });
      }

      // draw nodes
      nodesSel.attr("transform", d=>{
        const p=P.get(d.id);
        return `translate(${p.cx - p.w/2},${p.cy - p.h/2})`;
      });
      nodesSel.select("rect.node-rect")
        .attr("width",d=>P.get(d.id).w)
        .attr("height",d=>P.get(d.id).h)
        .attr("rx",d=>P.get(d.id).rx)
        .attr("ry",d=>P.get(d.id).rx)
        .attr("opacity",d=>0.85*(0.6+0.4*(d.z??0.5)));

      // labels for selected + neighbors only
      nodesSel.select("text.node-label").style("opacity",0);
      if(lockedIdRef.current){
        const neigh=getNeighborSet(lockedIdRef.current);
        neigh.forEach(id=>{
          const p=P.get(id); const nd=nodeById.get(id);
          if(p&&nd){ wrapLabel(nd,p.w);
            nodesSel.filter(n=>n.id===id).select("text.node-label")
              .attr("x",p.w/2).attr("y",8).style("opacity",1);
          }
        });
      }

      // edges
      const centerOf=(id)=>{const p=P.get(id); return p?{x:p.cx,y:p.cy}:null;};
      edgesSel.attr("d",e=>{
        const sC=centerOf(e.source), tC=centerOf(e.target);
        if(!sC||!tC) return null;
        const dist=Math.hypot(tC.x-sC.x,tC.y-sC.y);
        const cull=1400/Math.max(1,k);
        if(dist>cull && !lockedIdRef.current) return null;
        const xm=(sC.x+tC.x)/2, ym=(sC.y+tC.y)/2;
        return `M${sC.x},${sC.y} L${xm},${ym} L${tC.x},${tC.y}`;
      });

      // axes
      xAxisG.call(d3.axisBottom(newX).ticks(10).tickFormat(d3.format("d")));
      yAxisG.call(d3.axisLeft(newY).tickValues(fields.map((_,i)=>i)).tickFormat((i)=>fields[i]));
    }

    /* ------------------------------ Interactions ------------------------------ */
    let raf=null;
    nodesSel
      .on("mouseover", function(_,d){
        if(!lockedIdRef.current) highlightNeighborhood(d.id,{dim:false,raise:true});
      })
      .on("mouseout", function(){
        if(!lockedIdRef.current) applyDefaultEdgeStyle();
      })
      .on("mousemove", function(event,d){
        if(raf) return;
        raf=requestAnimationFrame(()=>{raf=null;showTip(event,d);});
      })
      .on("mouseleave", hideTip)
      .on("click", function(event,d){
        event.stopPropagation();
        if(lockedIdRef.current===d.id){
          lockedIdRef.current=null; setSelected(null); applyDefaultEdgeStyle();
        }else{
          lockedIdRef.current=d.id; setSelected(d);
          highlightNeighborhood(d.id,{dim:true,raise:true});
        }
        renderWithTransform(d3.zoomTransform(svg.node()));
      })
      .on("dblclick", function(event,d){
        event.preventDefault(); event.stopPropagation();
        const t0=d3.zoomTransform(svg.node());
        const yPix=yLane(fieldIndex(d.field));
        const xPix=x(d.year ?? yearsDomain[0]);
        const {w,h}=baseTileSize(d);
        const targetPx=0.75*Math.min(width,height);
        const kFromW=Math.pow(targetPx/Math.max(12,w),1/1.08);
        const kFromH=Math.pow(targetPx/Math.max(10,h),1/1.08);
        const kTarget=Math.min(24,Math.max(1.4,Math.min(kFromW,kFromH)));
        svg.transition().duration(620).ease(d3.easeCubicOut)
          .call(zoom.scaleTo,kTarget,[margin.left+xPix, margin.top+yPix]);
      });

    // background clear
    svg.on("click.clear",(event)=>{
      if(event.target===svg.node()){
        setSelected(null); lockedIdRef.current=null; applyDefaultEdgeStyle();
        renderWithTransform(d3.zoomTransform(svg.node()));
      }
    });
    d3.select(window).on("keydown.clear",(ev)=>{
      if(ev.key==="Escape"){
        setSelected(null); lockedIdRef.current=null; applyDefaultEdgeStyle();
        renderWithTransform(d3.zoomTransform(svg.node()));
      }
    });

    // first render
    renderWithTransform(d3.zoomIdentity);

    // resize
    const ro=new ResizeObserver(()=>renderWithTransform(d3.zoomTransform(svg.node())||d3.zoomIdentity));
    if(wrapRef.current) ro.observe(wrapRef.current);
    return ()=>{ ro.disconnect(); svg.on(".clear",null); d3.select(window).on("keydown.clear",null); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, edges, fields, fieldIndex, yearsDomain, yearsCenter, baseTileSize]);

  /* ---------------------------------- UI ---------------------------------- */
  return (
    <div className="app">
      <div className="header">
        <h1>Paper Map</h1>
        <p className="sub">Time-aligned X • persistent depth separation • jitter-free multi-gesture zoom</p>
      </div>

      <div className="chart-wrap" ref={wrapRef}>
        <svg ref={svgRef} />
        <div id="hover-tooltip" ref={tooltipRef} />
      </div>

      <aside className="sidebar">
        {selected ? (
          <Card node={selected} onClose={() => setSelected(null)} />
        ) : (
          <div className="placeholder">
            Hover to preview • Click a node to lock & reveal its network • Double-click to zoom to node
          </div>
        )}
      </aside>
    </div>
  );
}

/* =============================================================================
   Side card
============================================================================= */

function Card({ node, onClose }) {
  return (
    <div className="card">
      <div className="card-head">
        <h3>{node.title || "Untitled"}</h3>
        <button className="ghost" onClick={onClose} aria-label="Close">✕</button>
      </div>
      <div className="meta">
        <div><strong>Year:</strong> {node.year ?? "n/a"}</div>
        <div><strong>Field:</strong> {node.field}</div>
        <div><strong>Citations:</strong> {node.citationCount}</div>
      </div>
      {node.authors && <p><strong>Authors:</strong> {node.authors}</p>}
      {node.url && (
        <p>
          <a href={node.url} target="_blank" rel="noreferrer">Open paper</a>
        </p>
      )}
    </div>
  );
}
