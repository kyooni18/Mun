use std::sync::{Arc, Mutex};

use accesskit::{
    Action, ActionHandler, ActionRequest, ActivationHandler, DeactivationHandler, Node, NodeId,
    Rect, Role, TreeId, TreeInfo, TreeUpdate,
};
use accesskit_winit::Adapter;
use mun_runtime::{AccessibilityTree, ir::AccessibilityRole as MunAccessibilityRole};
use winit::{
    event::WindowEvent,
    event_loop::{ActiveEventLoop, EventLoopProxy},
    window::Window,
};

#[derive(Clone, Debug)]
pub enum NativeEvent {
    AccessibilityAction(ActionRequest),
}

#[derive(Clone)]
struct AccessibilitySnapshot {
    tree: AccessibilityTree,
    scale_factor: f32,
}

#[derive(Clone)]
struct Activation {
    snapshot: Arc<Mutex<AccessibilitySnapshot>>,
}

impl ActivationHandler for Activation {
    fn request_initial_tree(&mut self) -> Option<TreeUpdate> {
        let snapshot = self.snapshot.lock().expect("accessibility snapshot");
        Some(build_update(&snapshot.tree, snapshot.scale_factor, true))
    }
}

struct Actions {
    proxy: EventLoopProxy<NativeEvent>,
}

impl ActionHandler for Actions {
    fn do_action(&mut self, request: ActionRequest) {
        let _ = self
            .proxy
            .send_event(NativeEvent::AccessibilityAction(request));
    }
}

struct Deactivation;

impl DeactivationHandler for Deactivation {
    fn deactivate_accessibility(&mut self) {}
}

pub struct AccessibilityHost {
    adapter: Adapter,
    snapshot: Arc<Mutex<AccessibilitySnapshot>>,
}

impl AccessibilityHost {
    pub fn new(
        event_loop: &ActiveEventLoop,
        window: &Window,
        tree: AccessibilityTree,
        scale_factor: f32,
        proxy: EventLoopProxy<NativeEvent>,
    ) -> Self {
        let snapshot = Arc::new(Mutex::new(AccessibilitySnapshot { tree, scale_factor }));
        let adapter = Adapter::with_direct_handlers(
            event_loop,
            window,
            Activation {
                snapshot: snapshot.clone(),
            },
            Actions { proxy },
            Deactivation,
        );
        Self { adapter, snapshot }
    }

    pub fn process_event(&mut self, window: &Window, event: &WindowEvent) {
        self.adapter.process_event(window, event);
    }

    pub fn update(&mut self, tree: AccessibilityTree, scale_factor: f32) {
        {
            let mut snapshot = self.snapshot.lock().expect("accessibility snapshot");
            snapshot.tree = tree;
            snapshot.scale_factor = scale_factor;
        }
        let snapshot = self.snapshot.clone();
        self.adapter.update_if_active(move || {
            let snapshot = snapshot.lock().expect("accessibility snapshot");
            build_update(&snapshot.tree, snapshot.scale_factor, false)
        });
    }

    pub fn semantic_id_for(&self, target: NodeId) -> Option<String> {
        let snapshot = self.snapshot.lock().expect("accessibility snapshot");
        snapshot
            .tree
            .nodes
            .iter()
            .find(|node| node_id(&node.id) == target)
            .map(|node| node.id.clone())
    }
}

fn build_update(tree: &AccessibilityTree, scale_factor: f32, include_tree: bool) -> TreeUpdate {
    let mut nodes = Vec::with_capacity(tree.nodes.len());
    for item in &tree.nodes {
        let id = node_id(&item.id);
        let mut node = Node::new(role(item.role));
        if let Some(label) = &item.label {
            if item.role == MunAccessibilityRole::Text {
                node.set_value(label.clone());
            } else {
                node.set_label(label.clone());
            }
        }
        let scale = scale_factor as f64;
        node.set_bounds(Rect {
            x0: item.bounds.x as f64 * scale,
            y0: item.bounds.y as f64 * scale,
            x1: (item.bounds.x + item.bounds.width) as f64 * scale,
            y1: (item.bounds.y + item.bounds.height) as f64 * scale,
        });
        node.set_children(
            item.children
                .iter()
                .map(|child| node_id(child))
                .collect::<Vec<_>>(),
        );
        if !item.enabled {
            node.set_disabled();
        }
        if item.action_id.is_some() && item.enabled {
            node.add_action(Action::Click);
            node.add_action(Action::Focus);
        }
        nodes.push((id, node));
    }

    let root = node_id(&tree.root_id);
    let focus = tree.focus_id.as_deref().map(node_id).unwrap_or(root);
    let tree_info = include_tree.then(|| {
        let mut info = TreeInfo::new(root);
        info.toolkit_name = Some("Mün".into());
        info.toolkit_version = Some(env!("CARGO_PKG_VERSION").into());
        info
    });
    TreeUpdate {
        nodes,
        tree: tree_info,
        tree_id: TreeId::ROOT,
        focus,
    }
}

fn role(role: MunAccessibilityRole) -> Role {
    match role {
        MunAccessibilityRole::Window => Role::Window,
        MunAccessibilityRole::Group => Role::Group,
        MunAccessibilityRole::Text => Role::Label,
        MunAccessibilityRole::Button => Role::Button,
    }
}

fn node_id(value: &str) -> NodeId {
    // Stable FNV-1a IDs keep accessibility identity independent of traversal order.
    let mut hash = 0xcbf29ce484222325u64;
    for byte in value.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    if hash == 0 { NodeId(1) } else { NodeId(hash) }
}
