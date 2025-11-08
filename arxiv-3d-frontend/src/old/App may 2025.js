import React, { useState, useEffect, useRef } from "react";
import * as THREE from "three";
import { Canvas } from "@react-three/fiber";
import { OrbitControls, Html } from "@react-three/drei";
import "./App.css";

// Generate unique colors for categories
function generateColorMap(categories) {
  const colorMap = {};
  categories.forEach((cat, index) => {
    const hue = (index * 137) % 360;
    colorMap[cat] = `hsl(${hue}, 60%, 60%)`;
  });
  return colorMap;
}

function Timeline({ nodes }) {
  const xPositions = nodes.map(n => n.position[0]);
  const minX = Math.min(...xPositions);
  const maxX = Math.max(...xPositions);

  const decades = [];
  const startDecade = Math.floor(minX / 10) * 10;
  const endDecade = Math.ceil(maxX / 10) * 10;

  for (let x = startDecade; x <= endDecade; x += 10) {
    decades.push(x);
  }

  return (
    <group>
      {decades.map((x) => {
        const year = 1950 + Math.round(x / 10);
        return (
          <React.Fragment key={`tick-${x}`}>
            <mesh position={[x, -30, 0]}>
              <boxGeometry args={[0.5, 2, 0.5]} />
              <meshStandardMaterial color="gray" />
            </mesh>
            <Html position={[x, -32, 0]} center distanceFactor={8}>
              <div style={{ color: "#666", fontSize: "300px", fontWeight: "bold" }}>{year}</div>
            </Html>
          </React.Fragment>
        );
      })}
      <mesh position={[(minX + maxX) / 2, -30, 0]}>
        <boxGeometry args={[maxX - minX, 0.1, 0.1]} />
        <meshStandardMaterial color="#ccc" />
      </mesh>
    </group>
  );
}

// Inline Node component
function Node({ position, title, summary, citations, authors, year, arxiv_url, pdf_url, size, category, categories_all, ID_category, AI_primary_field, color }) {
  return (
    <mesh position={position}>
      <sphereGeometry args={[size, 32, 32]} />
      <meshStandardMaterial color={color} />
      <Html distanceFactor={10} style={{ transform: "scale(1)", width: "500px", pointerEvents: "auto"  }}>
        <div className="node-popup">
          <strong className="node-title">{title}</strong>
          <p className="node-summary">{summary}</p>
          <p className="node-authors"><strong>Authors:</strong> {authors.join(", ")}</p>
          <p className="node-year"><strong>year:</strong> {year}</p>
          <p className="node-category"><strong>Category:</strong> {category}</p>
          <p className="node-ID_category"><strong>ID_category:</strong> {ID_category}</p>
          <p className="node-AI_primary_field"><strong>AI_primary_field:</strong> {AI_primary_field}</p>
          <p className="node-citations"><strong>Citations:</strong> {citations}</p>
          <div className="node-links">
            <a href={arxiv_url} target="_blank" rel="noopener noreferrer">📄 arXiv</a> &nbsp;|&nbsp;
            <a href={pdf_url} target="_blank" rel="noopener noreferrer">📥 PDF</a>
          </div>
        </div>
      </Html>
    </mesh>
  );
}

function Arrow({ from, to }) {
  const dir = new THREE.Vector3().subVectors(to, from).normalize();
  const length = from.distanceTo(to);
  const arrowHelper = new THREE.ArrowHelper(dir, from, length, 0xaaaaaa);
  return <primitive object={arrowHelper} />;
}

function Legend({ colorMap }) {
  const categories = Object.keys(colorMap);
  return (
    <div style={{ position: "absolute", top: 20, left: 20, background: "white", padding: 10, borderRadius: 8, maxHeight: "80vh", overflowY: "auto", zIndex: 1 }}>
      <strong>Legend</strong>
      <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {categories.map((cat) => (
          <li key={cat} style={{ display: "flex", alignItems: "center", marginBottom: 4 }}>
            <span style={{ width: 12, height: 12, backgroundColor: colorMap[cat], display: "inline-block", marginRight: 6 }}></span>
            {cat}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Scene({ categoryColorMap, nodes }) {
  const [edges, setEdges] = useState([]);
  const nodeMap = useRef({});

  useEffect(() => {
    const map = {};
    nodes.forEach((n) => {
      map[n.id] = new THREE.Vector3(...n.position);
    });
    nodeMap.current = map;
  }, [nodes]);

  useEffect(() => {
    fetch("/edges.json")
      .then((res) => res.json())
      .then((data) => setEdges(data));
  }, []);

  return (
    <>
      <ambientLight />
      <pointLight position={[10, 10, 10]} />
      <Timeline nodes={nodes} />
      {nodes.map((node) => (
        <Node
          key={node.id}
          position={node.position}
          title={node.title}
          summary={node.summary}
          authors={node.authors}
          year={node.year}
          arxiv_url={node.arxiv_url}
          pdf_url={node.pdf_url}
          size={node.size}
          citations={node.citationCount}
          category={node.category}
          ID_category={node.ID_category}
          AI_field_list={node.AI_field_list}
          AI_primary_field={node.AI_primary_field}
          color={categoryColorMap[node.AI_primary_field] || "#888888"}
        />
      ))}
      {edges.map((edge, idx) => {
        const from = nodeMap.current[edge.source];
        const to = nodeMap.current[edge.target];
        return from && to ? <Arrow key={idx} from={from} to={to} /> : null;
      })}
    </>
  );
}

function App() {
  const [colorMap, setColorMap] = useState({});
  const [nodes, setNodes] = useState([]);

  useEffect(() => {
    fetch("/nodes.json")
      .then((res) => res.json())
      .then((data) => {
        setNodes(data);
        const categories = [...new Set(data.map(n => n.AI_primary_field))].sort();
        setColorMap(generateColorMap(categories));
      });
  }, []);

  return (
    <div style={{ width: "100vw", height: "100vh", position: "relative" }}>
      <Canvas camera={{ position: [0, 0, 150], fov: 60 }}>
        <Scene categoryColorMap={colorMap} nodes={nodes} />
        <OrbitControls />
      </Canvas>
      <Legend colorMap={colorMap} />
    </div>
  );
}

export default App;
