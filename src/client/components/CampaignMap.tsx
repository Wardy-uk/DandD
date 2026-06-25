interface MapNode {
  id: string;
  name: string;
  discovered: boolean;
  current: boolean;
  depth: number;
  lane: number;
  terrainType?: string;
  lightLevel?: string;
  faction?: string;
  encounterTheme?: string;
  battlefield?: {
    visibility: 'clear' | 'murky' | 'dark';
    cover: boolean;
    chokepoint: boolean;
    hazard: string | null;
    footing: 'stable' | 'uneven' | 'treacherous';
    pressure: string;
    summary: string;
    tacticalAdvice: string[];
  };
  roomState?: {
    hiddenExitFound: boolean;
    trapTriggered: boolean;
    trapDisarmed: boolean;
    obstacleCleared: boolean;
    lockOpened: boolean;
    stashFound: boolean;
    secured: boolean;
    fallbackPoint: boolean;
    safeCamp: boolean;
    cleared: boolean;
    knownHazard: boolean;
    knownTreasure: boolean;
  };
}

interface MapEdge {
  from: string;
  to: string;
  direction: string;
  locked: boolean;
}

interface CampaignMapData {
  currentSceneId: string;
  nodes: MapNode[];
  edges: MapEdge[];
}

interface Props {
  mapData: CampaignMapData | null;
}

export default function CampaignMap({ mapData }: Props) {
  if (!mapData || mapData.nodes.length === 0) {
    return (
      <div className="border border-leather/15 rounded-lg p-3 bg-parchment-light/40">
        <div className="text-[10px] font-heading font-bold text-ink-faint uppercase tracking-wider mb-2">
          Delver Map
        </div>
        <p className="text-xs font-body italic text-ink-faint">No mapped ground yet.</p>
      </div>
    );
  }

  const nodeWidth = 112;
  const nodeHeight = 56;
  const colGap = 150;
  const rowGap = 100;
  const positioned = mapData.nodes.map((node) => ({
    ...node,
    x: 24 + node.depth * colGap,
    y: 28 + node.lane * rowGap,
  }));
  const byId = new Map(positioned.map((node) => [node.id, node]));
  const maxX = Math.max(...positioned.map((node) => node.x)) + nodeWidth + 36;
  const maxY = Math.max(...positioned.map((node) => node.y)) + nodeHeight + 36;
  const focus = positioned.find((node) => node.current) || positioned[0];

  return (
    <div className="border border-leather/15 rounded-lg p-3 bg-parchment-light/40">
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="text-[10px] font-heading font-bold text-ink-faint uppercase tracking-wider">
          Delver Map
        </div>
        <div className="text-[10px] font-body text-ink-faint">
          {positioned.filter((node) => node.discovered).length} sites known
        </div>
      </div>

      <div className="overflow-x-auto overflow-y-hidden rounded-lg border border-leather/10 bg-parchment/70 [-webkit-overflow-scrolling:touch]">
        <div style={{ width: maxX, height: maxY, position: 'relative' }}>
          <svg width={maxX} height={maxY} className="absolute inset-0">
            {mapData.edges.map((edge) => {
              const from = byId.get(edge.from);
              const to = byId.get(edge.to);
              if (!from || !to) return null;
              const x1 = from.x + nodeWidth;
              const y1 = from.y + nodeHeight / 2;
              const x2 = to.x;
              const y2 = to.y + nodeHeight / 2;
              return (
                <g key={`${edge.from}-${edge.to}-${edge.direction}`}>
                  <path
                    d={`M ${x1} ${y1} C ${x1 + 36} ${y1}, ${x2 - 36} ${y2}, ${x2} ${y2}`}
                    fill="none"
                    stroke={edge.locked ? '#8b1a1a' : '#7c5b3c'}
                    strokeDasharray={edge.locked ? '5 4' : undefined}
                    strokeWidth="2"
                    opacity="0.7"
                  />
                  <text
                    x={(x1 + x2) / 2}
                    y={(y1 + y2) / 2 - 6}
                    textAnchor="middle"
                    fontSize="10"
                    fill="#7b6a58"
                  >
                    {edge.direction}
                  </text>
                </g>
              );
            })}
          </svg>

          {positioned.map((node) => (
            <div
              key={node.id}
              className={`absolute rounded-lg border px-2.5 py-2 shadow-sm ${
                node.current
                  ? 'border-gold bg-gold/15'
                  : node.discovered
                    ? 'border-leather/20 bg-parchment-light'
                    : 'border-leather/10 bg-parchment-dark/40 border-dashed'
              }`}
              style={{ left: node.x, top: node.y, width: nodeWidth, minHeight: nodeHeight }}
            >
              <div className={`font-heading text-xs font-bold ${node.current ? 'text-leather-dark' : 'text-ink-light'}`}>
                {node.name}
              </div>
              <div className="mt-1 text-[10px] font-body text-ink-faint">
                {node.discovered ? `${node.terrainType || 'unknown'} • ${node.lightLevel || 'normal'}` : 'route not yet explored'}
              </div>
              {node.discovered && (
                <div className="mt-1 flex flex-wrap gap-1">
                  {node.roomState?.fallbackPoint && <Marker label="FB" tone="gold" />}
                  {node.roomState?.safeCamp && <Marker label="Camp" tone="green" />}
                  {node.roomState?.cleared && <Marker label="Clear" tone="green" />}
                  {node.roomState?.knownTreasure && <Marker label="Loot" tone="gold" />}
                  {node.roomState?.knownHazard && <Marker label="Haz" tone="red" />}
                  {node.roomState?.hiddenExitFound && <Marker label="Secret" tone="ink" />}
                </div>
              )}
              {node.current && (
                <div className="mt-1 text-[10px] font-heading uppercase tracking-wide text-gold">
                  Party Here
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="mt-3 rounded-lg border border-leather/10 bg-parchment/60 p-3">
        <div className="font-heading text-xs font-bold text-leather-dark">{focus.name}</div>
        <div className="mt-1 text-xs font-body italic text-ink-light">
          {focus.battlefield?.summary || 'The party has only partial intel on this location.'}
        </div>
        {focus.discovered && (
          <div className="mt-2 grid grid-cols-1 gap-1 text-[11px] font-body text-ink-faint sm:grid-cols-2">
            <div>Faction: <span className="text-ink-light">{focus.faction || 'unknown'}</span></div>
            <div>Threat: <span className="text-ink-light">{focus.encounterTheme || 'unknown'}</span></div>
            <div>Visibility: <span className="text-ink-light">{focus.battlefield?.visibility || 'unknown'}</span></div>
            <div>Footing: <span className="text-ink-light">{focus.battlefield?.footing || 'unknown'}</span></div>
          </div>
        )}
        {focus.battlefield?.tacticalAdvice?.length ? (
          <div className="mt-2 space-y-1">
            {focus.battlefield.tacticalAdvice.slice(0, 2).map((tip) => (
              <p key={tip} className="text-[11px] font-body text-ink-faint">{tip}</p>
            ))}
          </div>
        ) : null}
        {focus.roomState && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {focus.roomState.fallbackPoint && <Marker label="Fallback Point" tone="gold" />}
            {focus.roomState.safeCamp && <Marker label="Camp Ready" tone="green" />}
            {focus.roomState.cleared && <Marker label="Cleared" tone="green" />}
            {focus.roomState.knownTreasure && <Marker label="Treasure Found" tone="gold" />}
            {focus.roomState.knownHazard && <Marker label="Hazard Known" tone="red" />}
            {focus.roomState.hiddenExitFound && <Marker label="Secret Route Found" tone="ink" />}
          </div>
        )}
      </div>
    </div>
  );
}

function Marker({ label, tone }: { label: string; tone: 'gold' | 'green' | 'red' | 'ink' }) {
  const tones: Record<string, string> = {
    gold: 'border-gold/30 bg-gold/10 text-gold',
    green: 'border-heal/30 bg-heal/10 text-heal',
    red: 'border-blood/30 bg-blood/10 text-blood',
    ink: 'border-leather/20 bg-parchment text-ink-faint',
  };
  return (
    <span className={`rounded-full border px-1.5 py-0.5 text-[9px] font-heading uppercase tracking-wide ${tones[tone]}`}>
      {label}
    </span>
  );
}
