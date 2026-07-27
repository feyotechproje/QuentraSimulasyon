// route.js
// Route building over the road graph. A route is an ordered list of
// { segId, dir } hops. Vehicles ride each hop from t=0 to t=1. When they reach
// the end of the route they request a fresh one (or despawn).

export class Router {
  constructor(net) {
    this.net = net;
  }

  randomNode() {
    const l = this.net.nodeList;
    return l[(Math.random() * l.length) | 0];
  }

  // Build a wandering route of `hops` segments starting at startNodeId,
  // avoiding immediate backtracking so vehicles flow forward.
  build(startNodeId, hops = 8) {
    const route = [];
    let current = startNodeId;
    let cameFromSeg = null;
    for (let i = 0; i < hops; i++) {
      const options = this.net.neighbours(current).filter((o) => o.segId !== cameFromSeg);
      const pick = (options.length ? options : this.net.neighbours(current))[
        (Math.random() * (options.length || 1)) | 0
      ];
      if (!pick) break;
      route.push({ segId: pick.segId, dir: pick.dir });
      cameFromSeg = pick.segId;
      current = pick.nodeId;
    }
    return { hops: route, destNodeId: current };
  }

  // Continue a route from the node a vehicle currently sits on.
  extend(nodeId, cameFromSeg, hops = 6) {
    const route = [];
    let current = nodeId;
    let last = cameFromSeg;
    for (let i = 0; i < hops; i++) {
      const options = this.net.neighbours(current).filter((o) => o.segId !== last);
      const pick = (options.length ? options : this.net.neighbours(current))[
        (Math.random() * (options.length || 1)) | 0
      ];
      if (!pick) break;
      route.push({ segId: pick.segId, dir: pick.dir });
      last = pick.segId;
      current = pick.nodeId;
    }
    return route;
  }
}
