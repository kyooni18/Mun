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
        if let Some(value) = &item.value {
            node.set_value(value.clone());
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
            if item.focused {
                node.add_action(Action::Blur);
            } else {
                node.add_action(Action::Focus);
            }
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
        MunAccessibilityRole::TextField => Role::TextInput,
        MunAccessibilityRole::RadioGroup => Role::RadioGroup,
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

#[cfg(test)]
mod tests {
    use super::*;
    use mun_runtime::{AccessibilityBounds, AccessibilityNode};

    #[test]
    fn text_input_name_and_committed_value_are_distinct() {
        let mut tree = semantic_tree();
        let field = &mut tree.nodes[1];
        field.role = MunAccessibilityRole::TextField;
        field.label = Some("Name".into());
        field.value = Some("한글".into());
        let update = build_update(&tree, 2.0, true);
        let node = &update
            .nodes
            .iter()
            .find(|(id, _)| *id == node_id("primary"))
            .unwrap()
            .1;
        assert_eq!(node.role(), Role::TextInput);
        assert_eq!(node.label(), Some("Name"));
        assert_eq!(node.value(), Some("한글"));
    }

    fn semantic_tree() -> AccessibilityTree {
        AccessibilityTree {
            root_id: "root".into(),
            focus_id: Some("primary".into()),
            nodes: vec![
                AccessibilityNode {
                    id: "root".into(),
                    role: MunAccessibilityRole::Window,
                    label: Some("Window".into()),
                    value: None,
                    enabled: true,
                    focused: false,
                    bounds: AccessibilityBounds {
                        x: 0.0,
                        y: 0.0,
                        width: 320.0,
                        height: 200.0,
                    },
                    children: vec!["primary".into(), "disabled".into(), "label".into()],
                    action_id: None,
                },
                AccessibilityNode {
                    id: "primary".into(),
                    role: MunAccessibilityRole::Button,
                    label: Some("Primary".into()),
                    value: None,
                    enabled: true,
                    focused: true,
                    bounds: AccessibilityBounds {
                        x: 10.0,
                        y: 20.0,
                        width: 100.0,
                        height: 40.0,
                    },
                    children: Vec::new(),
                    action_id: Some("primary".into()),
                },
                AccessibilityNode {
                    id: "disabled".into(),
                    role: MunAccessibilityRole::Button,
                    label: Some("Disabled".into()),
                    value: None,
                    enabled: false,
                    focused: false,
                    bounds: AccessibilityBounds {
                        x: 10.0,
                        y: 70.0,
                        width: 100.0,
                        height: 40.0,
                    },
                    children: Vec::new(),
                    action_id: Some("disabled".into()),
                },
                AccessibilityNode {
                    id: "label".into(),
                    role: MunAccessibilityRole::Text,
                    label: Some("Status".into()),
                    value: None,
                    enabled: true,
                    focused: false,
                    bounds: AccessibilityBounds {
                        x: 10.0,
                        y: 120.0,
                        width: 80.0,
                        height: 20.0,
                    },
                    children: Vec::new(),
                    action_id: None,
                },
            ],
        }
    }

    fn update_node<'a>(update: &'a TreeUpdate, semantic_id: &str) -> &'a Node {
        let id = node_id(semantic_id);
        &update
            .nodes
            .iter()
            .find(|(candidate, _)| *candidate == id)
            .expect("accessibility node")
            .1
    }

    #[test]
    fn accesskit_update_preserves_semantics_focus_and_presentation_bounds() {
        let update = build_update(&semantic_tree(), 2.0, true);

        assert_eq!(update.focus, node_id("primary"));
        assert_eq!(
            update.tree.as_ref().expect("initial tree").root,
            node_id("root")
        );

        let root = update_node(&update, "root");
        assert_eq!(root.role(), Role::Window);
        assert_eq!(root.label(), Some("Window"));
        assert_eq!(
            root.children(),
            &[node_id("primary"), node_id("disabled"), node_id("label")]
        );

        let primary = update_node(&update, "primary");
        assert_eq!(primary.role(), Role::Button);
        assert_eq!(primary.label(), Some("Primary"));
        assert_eq!(
            primary.bounds(),
            Some(Rect {
                x0: 20.0,
                y0: 40.0,
                x1: 220.0,
                y1: 120.0,
            })
        );
        assert!(primary.supports_action(Action::Click));
        assert!(primary.supports_action(Action::Blur));
        assert!(!primary.supports_action(Action::Focus));

        let disabled = update_node(&update, "disabled");
        assert!(disabled.is_disabled());
        assert!(!disabled.supports_action(Action::Click));
        assert!(!disabled.supports_action(Action::Focus));

        let label = update_node(&update, "label");
        assert_eq!(label.role(), Role::Label);
        assert_eq!(label.value(), Some("Status"));
    }

    #[test]
    fn unfocused_enabled_action_advertises_focus_not_blur() {
        let mut tree = semantic_tree();
        tree.focus_id = None;
        let primary = tree
            .nodes
            .iter_mut()
            .find(|node| node.id == "primary")
            .expect("primary semantic node");
        primary.focused = false;

        let update = build_update(&tree, 1.0, false);
        let primary = update_node(&update, "primary");
        assert!(primary.supports_action(Action::Click));
        assert!(primary.supports_action(Action::Focus));
        assert!(!primary.supports_action(Action::Blur));
        assert_eq!(update.focus, node_id("root"));
    }
}
