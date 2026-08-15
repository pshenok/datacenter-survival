// The loss taxonomy — pure data, zero imports (the Server Survival
// failure-reasons discipline). Every kW of demand this facility fails to
// serve is attributed to exactly one of these, so "you lost $340 this run"
// can always be decomposed into named, fixable causes.
//
// severity drives the badge colour: "degraded" means the machine protected
// itself and kept working (amber), "dropped" means the work was simply not
// done (red).

export const LOSS_CAUSES = {
    thermal: { key: "loss_thermal", severity: "degraded", color: "#f59e0b" },
    link_clip: { key: "loss_link_clip", severity: "degraded", color: "#f59e0b" },
    brownout: { key: "loss_brownout", severity: "degraded", color: "#fb923c" },
    breaker_tripped: { key: "loss_breaker", severity: "dropped", color: "#ef4444" },
    maintenance: { key: "loss_maintenance", severity: "dropped", color: "#38bdf8" },
    dead_chain: { key: "loss_dead_chain", severity: "dropped", color: "#ef4444" },
    battery_empty: { key: "loss_battery_empty", severity: "dropped", color: "#ef4444" },
    tank_dry: { key: "loss_tank_dry", severity: "dropped", color: "#ef4444" },
    no_capacity: { key: "loss_no_capacity", severity: "dropped", color: "#a78bfa" },
};

export const CAUSE_IDS = Object.keys(LOSS_CAUSES);
