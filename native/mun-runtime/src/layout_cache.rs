//! Persistent Taffy tree reused across frames and compatible hot updates.
//!
//! Every frame the runtime still derives the complete layout input (style,
//! intrinsic measurement and children) of every live node from Mün semantics,
//! so nothing here can go stale: this module only diffs that input against the
//! retained Taffy nodes, keyed by semantic node id, and touches the nodes whose
//! input actually changed. Taffy's per-node layout cache then recomputes only
//! dirty nodes and their ancestors; an unchanged subtree is answered from cache.
use rustc_hash::FxHashMap;
use taffy::{TaffyError, prelude::*};

use crate::layout::IntrinsicSize;

pub(crate) type LayoutTree = TaffyTree<IntrinsicSize>;
/// Semantic node id -> retained layout node. Keys are long node-id strings
/// hashed for every node every frame, so a fast non-DoS hasher is used.
pub(crate) type LayoutNodes = FxHashMap<String, NodeId>;

/// Layout input of one node of the frame being built.
pub(crate) struct LayoutSpec<'a> {
    pub id: &'a str,
    pub style: Style,
    /// Intrinsic size of a leaf; always `None` for a node with children.
    pub context: Option<IntrinsicSize>,
    /// Indices into the frame's spec list.
    pub children: Vec<usize>,
}

/// Work done by one [`LayoutCache::sync`] (structural counters, deterministic
/// for a given sequence of frames).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct LayoutSyncStats {
    pub live: usize,
    pub created: usize,
    pub removed: usize,
    pub restyled: usize,
    pub remeasured: usize,
    pub rechildren: usize,
}

impl LayoutSyncStats {
    /// Nodes whose own layout input changed this frame.
    pub fn invalidated(&self) -> usize {
        self.created + self.removed + self.restyled + self.remeasured + self.rechildren
    }
}

pub(crate) struct LayoutCache {
    pub taffy: LayoutTree,
    pub nodes: LayoutNodes,
    /// Window node proposing the window size to the root views.
    wrapper: Option<NodeId>,
    /// Nodes created for a semantic id already used in the same frame. Ids are
    /// validated unique, so this stays empty; they are dropped next frame.
    duplicates: Vec<NodeId>,
    pub last_sync: LayoutSyncStats,
}

impl Default for LayoutCache {
    fn default() -> Self {
        Self {
            taffy: TaffyTree::new(),
            nodes: LayoutNodes::default(),
            wrapper: None,
            duplicates: Vec::new(),
            last_sync: LayoutSyncStats::default(),
        }
    }
}

impl LayoutCache {
    pub fn wrapper(&self) -> Option<NodeId> {
        self.wrapper
    }

    /// Bring the retained tree in line with `specs` (children listed before
    /// their parents) and the window `roots`.
    pub fn sync(
        &mut self,
        specs: &[LayoutSpec<'_>],
        roots: &[usize],
        wrapper_style: Style,
    ) -> Result<(), TaffyError> {
        let mut stats = LayoutSyncStats {
            live: specs.len(),
            ..Default::default()
        };
        let mut previous = std::mem::take(&mut self.nodes);
        self.nodes.reserve(specs.len());
        let mut stale = std::mem::take(&mut self.duplicates);
        let mut ids = Vec::with_capacity(specs.len());
        for spec in specs {
            let reused = if self.nodes.contains_key(spec.id) {
                None
            } else {
                previous.remove_entry(spec.id)
            };
            let node = match reused {
                Some((key, node)) => {
                    if self.taffy.style(node)? != &spec.style {
                        self.taffy.set_style(node, spec.style.clone())?;
                        self.invalidate(node)?;
                        stats.restyled += 1;
                    }
                    if self.taffy.get_node_context(node) != spec.context.as_ref() {
                        self.taffy.set_node_context(node, spec.context)?;
                        self.invalidate(node)?;
                        stats.remeasured += 1;
                    }
                    self.nodes.insert(key, node);
                    node
                }
                None => {
                    let node = match spec.context {
                        Some(context) => self
                            .taffy
                            .new_leaf_with_context(spec.style.clone(), context)?,
                        None => self.taffy.new_leaf(spec.style.clone())?,
                    };
                    stats.created += 1;
                    if self.nodes.contains_key(spec.id) {
                        self.duplicates.push(node);
                    } else {
                        self.nodes.insert(spec.id.to_owned(), node);
                    }
                    node
                }
            };
            ids.push(node);
        }

        // Detach every stale node from its children first: a child may have
        // moved to a live parent, and removing its old parent must not clear
        // the new link.
        stale.extend(previous.into_values());
        stats.removed = stale.len();
        for &node in &stale {
            self.taffy.set_children(node, &[])?;
        }
        for node in stale {
            if let Some(parent) = self.taffy.parent(node) {
                self.invalidate(parent)?;
            }
            self.taffy.remove(node)?;
        }

        let mut children = Vec::new();
        for (spec, &node) in specs.iter().zip(&ids) {
            children.clear();
            children.extend(spec.children.iter().map(|&child| ids[child]));
            if self.set_children_if_changed(node, &children)? {
                stats.rechildren += 1;
            }
        }

        let wrapper = match self.wrapper {
            Some(wrapper) => {
                if self.taffy.style(wrapper)? != &wrapper_style {
                    self.taffy.set_style(wrapper, wrapper_style)?;
                    self.invalidate(wrapper)?;
                }
                wrapper
            }
            None => {
                let wrapper = self.taffy.new_leaf(wrapper_style)?;
                self.wrapper = Some(wrapper);
                wrapper
            }
        };
        children.clear();
        children.extend(roots.iter().map(|&root| ids[root]));
        self.set_children_if_changed(wrapper, &children)?;
        self.last_sync = stats;
        Ok(())
    }

    fn set_children_if_changed(
        &mut self,
        node: NodeId,
        children: &[NodeId],
    ) -> Result<bool, TaffyError> {
        if self.taffy.child_ids(node).eq(children.iter().copied()) {
            return Ok(false);
        }
        // A child moving here leaves its previous parent; that parent's layout
        // depends on the child too.
        for &child in children {
            if let Some(parent) = self.taffy.parent(child).filter(|parent| *parent != node) {
                self.invalidate(parent)?;
            }
        }
        self.taffy.set_children(node, children)?;
        self.invalidate(node)?;
        Ok(true)
    }

    /// Clear the cached layout of `node` and of every ancestor. Taffy's own
    /// propagation stops at a node whose cache is already empty; walking the
    /// whole ancestor chain keeps an ancestor from answering from stale cache
    /// even if some intermediate node was never laid out.
    fn invalidate(&mut self, node: NodeId) -> Result<(), TaffyError> {
        let mut current = Some(node);
        while let Some(node) = current {
            self.taffy.mark_dirty(node)?;
            current = self.taffy.parent(node);
        }
        Ok(())
    }
}
