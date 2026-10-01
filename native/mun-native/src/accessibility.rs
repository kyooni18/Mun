use std::sync::{Arc, Mutex};

use accesskit::{
    Action, ActionData, ActionHandler, ActionRequest, ActivationHandler, DeactivationHandler, Node,
    NodeId, Rect, Role, ScrollUnit, TextPosition, TextSelection, Toggled, TreeId, TreeInfo,
    TreeUpdate,
};
use accesskit_winit::Adapter;
use mun_runtime::accessibility::{AccessibilityAction as MunAction, AccessibleText};
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

    /// Translate a platform request into a semantic runtime action against the
    /// tree the platform last saw. Unknown targets and unsupported data are
    /// ignored rather than guessed.
    pub fn semantic_request(&self, request: &ActionRequest) -> Option<(String, MunAction)> {
        let snapshot = self.snapshot.lock().expect("accessibility snapshot");
        translate_request(&snapshot.tree, snapshot.scale_factor, request)
    }
}

fn translate_request(
    tree: &AccessibilityTree,
    scale_factor: f32,
    request: &ActionRequest,
) -> Option<(String, MunAction)> {
    let node = tree
        .nodes
        .iter()
        .find(|node| node_id(&node.id) == request.target_node)?;
    let id = node.id.clone();
    let action = match (request.action, &request.data) {
        (Action::Click, _) => MunAction::Activate,
        (Action::Focus, _) => MunAction::Focus,
        (Action::Blur, _) => MunAction::Blur,
        (Action::ScrollIntoView, _) => MunAction::ScrollIntoView,
        (Action::SetTextSelection, Some(ActionData::SetTextSelection(selection))) => {
            let text = node.text.as_ref()?;
            let runs = text_runs(text);
            MunAction::SetTextSelection {
                anchor: grapheme_at(text, &runs, selection.anchor)?,
                focus: grapheme_at(text, &runs, selection.focus)?,
            }
        }
        (Action::ReplaceSelectedText, Some(ActionData::Value(value))) => {
            MunAction::ReplaceSelectedText(value.to_string())
        }
        (Action::SetValue, Some(ActionData::Value(value))) => {
            MunAction::SetValue(value.to_string())
        }
        (
            Action::ScrollUp | Action::ScrollDown | Action::ScrollLeft | Action::ScrollRight,
            data,
        ) => {
            let scroll = node.scroll?;
            let forward = matches!(request.action, Action::ScrollDown | Action::ScrollRight);
            let sign = if forward { 1.0 } else { -1.0 };
            match data {
                Some(ActionData::ScrollUnit(ScrollUnit::Item)) => MunAction::SetScrollOffset(
                    scroll.offset + sign * mun_runtime::scroll_view::SCROLL_LINE,
                ),
                _ => MunAction::ScrollByPages(sign),
            }
        }
        (Action::SetScrollOffset, Some(ActionData::SetScrollOffset(point))) => {
            let scroll = node.scroll?;
            let value = if scroll.horizontal { point.x } else { point.y };
            MunAction::SetScrollOffset(value as f32 / scale_factor.max(f32::EPSILON))
        }
        _ => return None,
    };
    Some((id, action))
}

/// AccessKit stores per-run character data as `u8`: runs hold at most 255
/// characters and a character at most 255 UTF-8 bytes. Each platform
/// character records the runtime grapheme it belongs to; a grapheme longer
/// than 255 bytes (pathological ZWJ chains) spans several platform characters.
struct PlatformRun {
    text: String,
    lengths: Vec<u8>,
    graphemes: Vec<usize>,
    positions: Vec<f32>,
    widths: Vec<f32>,
    word_starts: Vec<u8>,
}

const MAX_RUN: usize = u8::MAX as usize;

fn text_runs(text: &AccessibleText) -> Vec<PlatformRun> {
    let mut runs: Vec<PlatformRun> = Vec::new();
    let mut byte = 0;
    for (grapheme, &length) in text.character_lengths.iter().enumerate() {
        let source = &text.value[byte..byte + length];
        byte += length;
        let mut pieces = Vec::new();
        let mut start = 0;
        for (index, ch) in source.char_indices() {
            if index + ch.len_utf8() - start > MAX_RUN {
                pieces.push(&source[start..index]);
                start = index;
            }
        }
        pieces.push(&source[start..]);
        let position = text
            .character_positions
            .get(grapheme)
            .copied()
            .unwrap_or(0.0);
        let width = text.character_widths.get(grapheme).copied().unwrap_or(0.0);
        let starts_word = text.word_starts.binary_search(&grapheme).is_ok();
        for (piece_index, piece) in pieces.iter().enumerate() {
            if runs.last().is_none_or(|run| run.lengths.len() == MAX_RUN) {
                runs.push(PlatformRun {
                    text: String::new(),
                    lengths: Vec::new(),
                    graphemes: Vec::new(),
                    positions: Vec::new(),
                    widths: Vec::new(),
                    word_starts: Vec::new(),
                });
            }
            let run = runs.last_mut().expect("run");
            if starts_word && piece_index == 0 {
                run.word_starts.push(run.lengths.len() as u8);
            }
            run.text.push_str(piece);
            run.lengths.push(piece.len() as u8);
            run.graphemes.push(grapheme);
            run.positions.push(position);
            run.widths.push(if piece_index == 0 { width } else { 0.0 });
        }
    }
    if runs.is_empty() {
        runs.push(PlatformRun {
            text: String::new(),
            lengths: Vec::new(),
            graphemes: Vec::new(),
            positions: Vec::new(),
            widths: Vec::new(),
            word_starts: Vec::new(),
        });
    }
    runs
}

fn run_id(text: &AccessibleText, index: usize) -> NodeId {
    node_id(&format!("{}#{index}", text.id))
}

/// Platform position for a runtime grapheme index (end-of-text allowed).
fn text_position(text: &AccessibleText, runs: &[PlatformRun], grapheme: usize) -> TextPosition {
    for (index, run) in runs.iter().enumerate() {
        if let Some(character) = run.graphemes.iter().position(|item| *item == grapheme) {
            return TextPosition {
                node: run_id(text, index),
                character_index: character,
            };
        }
    }
    let last = runs.len() - 1;
    TextPosition {
        node: run_id(text, last),
        character_index: runs[last].lengths.len(),
    }
}

/// Runtime grapheme for a platform position; mid-grapheme pieces snap to the
/// grapheme start so a selection never splits a cluster.
fn grapheme_at(
    text: &AccessibleText,
    runs: &[PlatformRun],
    position: TextPosition,
) -> Option<usize> {
    let (index, run) = runs
        .iter()
        .enumerate()
        .find(|(index, _)| run_id(text, *index) == position.node)?;
    if let Some(grapheme) = run.graphemes.get(position.character_index) {
        return Some(*grapheme);
    }
    // End of a run is the start of the next run's first grapheme, or the end
    // of the text after the last run.
    Some(
        match runs.get(index + 1).and_then(|next| next.graphemes.first()) {
            Some(next) => *next,
            None => text.character_lengths.len(),
        },
    )
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
        let mut children = item
            .children
            .iter()
            .map(|child| node_id(child))
            .collect::<Vec<_>>();
        if !item.enabled {
            node.set_disabled();
        }
        if let Some(checked) = item.checked {
            node.set_toggled(if checked {
                Toggled::True
            } else {
                Toggled::False
            });
        }
        let is_option = item.role == MunAccessibilityRole::RadioButton;
        if item.action_id.is_some() && item.enabled {
            node.add_action(Action::Click);
            // Options take focus through their group, never individually.
            if !is_option {
                if item.focused {
                    node.add_action(Action::Blur);
                } else {
                    node.add_action(Action::Focus);
                }
            }
        }
        if item.id != tree.root_id {
            node.add_action(Action::ScrollIntoView);
        }
        if let Some(scroll) = item.scroll {
            let (offset, max) = (scroll.offset as f64 * scale, scroll.max as f64 * scale);
            if scroll.horizontal {
                node.set_scroll_x(offset);
                node.set_scroll_x_min(0.0);
                node.set_scroll_x_max(max);
                node.add_action(Action::ScrollLeft);
                node.add_action(Action::ScrollRight);
            } else {
                node.set_scroll_y(offset);
                node.set_scroll_y_min(0.0);
                node.set_scroll_y_max(max);
                node.add_action(Action::ScrollUp);
                node.add_action(Action::ScrollDown);
            }
            node.add_action(Action::SetScrollOffset);
        }
        if let Some(text) = &item.text {
            let runs = text_runs(text);
            for (index, run) in runs.iter().enumerate() {
                let origin = run.positions.first().copied().unwrap_or(0.0);
                let mut run_node = Node::new(Role::TextRun);
                run_node.set_value(run.text.clone());
                run_node.set_character_lengths(run.lengths.clone());
                run_node.set_character_positions(
                    run.positions
                        .iter()
                        .map(|position| (position - origin) * scale_factor)
                        .collect::<Vec<_>>(),
                );
                run_node.set_character_widths(
                    run.widths
                        .iter()
                        .map(|width| width * scale_factor)
                        .collect::<Vec<_>>(),
                );
                run_node.set_word_starts(run.word_starts.clone());
                let end = run
                    .positions
                    .iter()
                    .zip(&run.widths)
                    .map(|(position, width)| position + width)
                    .fold(origin, f32::max);
                run_node.set_bounds(Rect {
                    x0: (text.bounds.x + origin) as f64 * scale,
                    y0: text.bounds.y as f64 * scale,
                    x1: (text.bounds.x + end) as f64 * scale,
                    y1: (text.bounds.y + text.bounds.height) as f64 * scale,
                });
                let id = run_id(text, index);
                children.push(id);
                nodes.push((id, run_node));
            }
            if let Some((anchor, focus)) = text.selection {
                node.set_text_selection(TextSelection {
                    anchor: text_position(text, &runs, anchor),
                    focus: text_position(text, &runs, focus),
                });
            }
            if item.enabled {
                node.add_action(Action::SetTextSelection);
                node.add_action(Action::ReplaceSelectedText);
                node.add_action(Action::SetValue);
            }
        }
        node.set_children(children);
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
        MunAccessibilityRole::RadioButton => Role::RadioButton,
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
                    checked: None,
                    text: None,
                    scroll: None,
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
                    checked: None,
                    text: None,
                    scroll: None,
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
                    checked: None,
                    text: None,
                    scroll: None,
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
                    checked: None,
                    text: None,
                    scroll: None,
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

    fn text_tree(value: &str, selection: Option<(usize, usize)>) -> AccessibilityTree {
        use unicode_segmentation::UnicodeSegmentation;
        let mut tree = semantic_tree();
        let field = &mut tree.nodes[1];
        field.role = MunAccessibilityRole::TextField;
        let lengths: Vec<usize> = value.graphemes(true).map(str::len).collect();
        field.text = Some(AccessibleText {
            id: "primary:text-run".into(),
            value: value.into(),
            character_positions: (0..lengths.len())
                .map(|index| index as f32 * 10.0)
                .collect(),
            character_widths: vec![10.0; lengths.len()],
            word_starts: vec![0],
            character_lengths: lengths,
            bounds: AccessibilityBounds {
                x: 20.0,
                y: 30.0,
                width: 0.0,
                height: 20.0,
            },
            selection,
        });
        tree
    }

    #[test]
    fn long_text_is_split_into_u8_runs_and_selection_round_trips_by_grapheme() {
        // 300 graphemes, each "한" (3 bytes) or a 2-scalar combining cluster.
        let value: String = (0..300)
            .map(|i| if i % 2 == 0 { "한" } else { "e\u{301}" })
            .collect();
        let tree = text_tree(&value, Some((254, 290)));
        let update = build_update(&tree, 2.0, false);
        let field = update_node(&update, "primary");
        let runs: Vec<_> = field
            .children()
            .iter()
            .map(|id| {
                &update
                    .nodes
                    .iter()
                    .find(|(candidate, _)| candidate == id)
                    .unwrap()
                    .1
            })
            .collect();
        assert_eq!(runs.len(), 2);
        assert_eq!(runs[0].character_lengths().len(), 255);
        assert_eq!(runs[1].character_lengths().len(), 45);
        assert_eq!(
            runs.iter()
                .map(|run| run.value().unwrap())
                .collect::<String>(),
            value
        );
        // Positions are run-local and scaled.
        assert_eq!(runs[1].character_positions().unwrap()[1], 20.0);
        let selection = field.text_selection().unwrap();
        assert_eq!(selection.anchor.character_index, 254);
        assert_eq!(selection.focus.node, field.children()[1]);
        assert_eq!(selection.focus.character_index, 35);

        let request = ActionRequest {
            action: Action::SetTextSelection,
            target_tree: TreeId::ROOT,
            target_node: node_id("primary"),
            data: Some(ActionData::SetTextSelection(TextSelection {
                anchor: TextPosition {
                    node: field.children()[0],
                    character_index: 255,
                },
                focus: TextPosition {
                    node: field.children()[1],
                    character_index: 45,
                },
            })),
        };
        let (_, action) = translate_request(&tree, 2.0, &request).unwrap();
        assert_eq!(
            action,
            MunAction::SetTextSelection {
                anchor: 255,
                focus: 300
            }
        );
    }

    #[test]
    fn oversized_grapheme_spans_platform_characters_but_maps_back_to_one_cluster() {
        // 60 ZWJ-joined emoji form one cluster of 417 UTF-8 bytes.
        let family = ["👨"; 60].join("\u{200D}");
        let value = format!("a{family}b");
        let tree = text_tree(&value, Some((2, 2)));
        let runs = text_runs(tree.nodes[1].text.as_ref().unwrap());
        let platform: Vec<usize> = runs.iter().flat_map(|run| run.graphemes.clone()).collect();
        assert!(platform.iter().filter(|grapheme| **grapheme == 1).count() > 1);
        assert!(
            runs.iter()
                .all(|run| run.lengths.iter().all(|length| *length > 0))
        );
        let text = tree.nodes[1].text.as_ref().unwrap();
        let middle = TextPosition {
            node: run_id(text, 0),
            character_index: 2,
        };
        assert_eq!(
            grapheme_at(text, &runs, middle),
            Some(1),
            "snaps to cluster start"
        );
    }
}
