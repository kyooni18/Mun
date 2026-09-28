use std::collections::{HashMap, HashSet};

use thiserror::Error;

/// Framework-owned semantic node kinds. These identities intentionally do not
/// expose Taffy node handles, renderer primitives, or platform widgets.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum RetainedNodeKind {
    Window,
    Column,
    Row,
    Conditional,
    Text,
    Panel,
    Action,
}

impl RetainedNodeKind {
    /// Conditional and window nodes participate in the semantic tree without
    /// manufacturing visual/layout boxes of their own.
    pub fn has_layout_box(self) -> bool {
        !matches!(self, Self::Window | Self::Conditional)
    }
}

/// A stable runtime instance attached to one semantic UI IR identity.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RetainedNode {
    pub id: String,
    pub kind: RetainedNodeKind,
    pub instance_id: u64,
    pub parent: Option<String>,
    pub children: Vec<String>,
}

impl RetainedNode {
    pub fn has_layout_box(&self) -> bool {
        self.kind.has_layout_box()
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct RetainedReconciliation {
    pub inserted: Vec<String>,
    pub removed: Vec<String>,
    pub retained: Vec<String>,
    pub replaced: Vec<String>,
    pub reparented: Vec<String>,
    pub children_changed: Vec<String>,
}

impl RetainedReconciliation {
    pub fn is_empty(&self) -> bool {
        self.inserted.is_empty()
            && self.removed.is_empty()
            && self.replaced.is_empty()
            && self.reparented.is_empty()
            && self.children_changed.is_empty()
    }
}

#[derive(Debug, Error, Eq, PartialEq)]
pub enum RetainedTreeError {
    #[error("duplicate active semantic node identity '{0}'")]
    DuplicateIdentity(String),
}

#[derive(Clone, Debug)]
pub(crate) struct RetainedNodeSpec {
    pub id: String,
    pub kind: RetainedNodeKind,
    pub parent: Option<String>,
    pub children: Vec<String>,
}

impl RetainedNodeSpec {
    pub(crate) fn new(
        id: impl Into<String>,
        kind: RetainedNodeKind,
        parent: Option<String>,
        children: Vec<String>,
    ) -> Self {
        Self {
            id: id.into(),
            kind,
            parent,
            children,
        }
    }
}

/// Active framework-owned semantic tree.
///
/// Semantic UI IR node IDs are the canonical identity. Runtime instance IDs are
/// allocated only when an identity first appears or when the same semantic ID
/// changes node kind, which is an explicit replacement. Taffy IDs and scene
/// primitive indices never participate in reconciliation.
#[derive(Clone, Debug, Default)]
pub struct RetainedTree {
    nodes: HashMap<String, RetainedNode>,
    order: Vec<String>,
    next_instance_id: u64,
    revision: u64,
}

impl RetainedTree {
    pub fn node(&self, id: &str) -> Option<&RetainedNode> {
        self.nodes.get(id)
    }

    pub fn root(&self) -> Option<&RetainedNode> {
        self.order.first().and_then(|id| self.nodes.get(id))
    }

    pub fn len(&self) -> usize {
        self.nodes.len()
    }

    pub fn is_empty(&self) -> bool {
        self.nodes.is_empty()
    }

    pub fn revision(&self) -> u64 {
        self.revision
    }

    pub fn iter(&self) -> impl Iterator<Item = &RetainedNode> {
        self.order.iter().filter_map(|id| self.nodes.get(id))
    }

    fn allocate_instance_id(&mut self) -> u64 {
        let next = self.next_instance_id.max(1);
        self.next_instance_id = next.saturating_add(1);
        next
    }

    pub(crate) fn reconcile(
        &mut self,
        specs: Vec<RetainedNodeSpec>,
    ) -> Result<RetainedReconciliation, RetainedTreeError> {
        let mut seen = HashSet::with_capacity(specs.len());
        for spec in &specs {
            if !seen.insert(spec.id.clone()) {
                return Err(RetainedTreeError::DuplicateIdentity(spec.id.clone()));
            }
        }

        let previous_nodes = std::mem::take(&mut self.nodes);
        let previous_order = std::mem::take(&mut self.order);
        let mut next_nodes = HashMap::with_capacity(specs.len());
        let mut next_order = Vec::with_capacity(specs.len());
        let mut diff = RetainedReconciliation::default();

        for spec in specs {
            let id = spec.id.clone();
            next_order.push(id.clone());

            let node = match previous_nodes.get(&id) {
                Some(previous) if previous.kind == spec.kind => {
                    diff.retained.push(id.clone());
                    if previous.parent != spec.parent {
                        diff.reparented.push(id.clone());
                    }
                    if previous.children != spec.children {
                        diff.children_changed.push(id.clone());
                    }
                    RetainedNode {
                        id: id.clone(),
                        kind: spec.kind,
                        instance_id: previous.instance_id,
                        parent: spec.parent,
                        children: spec.children,
                    }
                }
                Some(_) => {
                    diff.replaced.push(id.clone());
                    RetainedNode {
                        id: id.clone(),
                        kind: spec.kind,
                        instance_id: self.allocate_instance_id(),
                        parent: spec.parent,
                        children: spec.children,
                    }
                }
                None => {
                    diff.inserted.push(id.clone());
                    RetainedNode {
                        id: id.clone(),
                        kind: spec.kind,
                        instance_id: self.allocate_instance_id(),
                        parent: spec.parent,
                        children: spec.children,
                    }
                }
            };
            next_nodes.insert(id, node);
        }

        for id in previous_order {
            if !next_nodes.contains_key(&id) {
                diff.removed.push(id);
            }
        }

        self.nodes = next_nodes;
        self.order = next_order;
        if !diff.is_empty() {
            self.revision = self.revision.saturating_add(1);
        }
        Ok(diff)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(
        id: &str,
        kind: RetainedNodeKind,
        parent: Option<&str>,
        children: &[&str],
    ) -> RetainedNodeSpec {
        RetainedNodeSpec::new(
            id,
            kind,
            parent.map(str::to_owned),
            children.iter().map(|child| (*child).to_owned()).collect(),
        )
    }

    #[test]
    fn stable_identity_survives_sibling_insertion() {
        let mut tree = RetainedTree::default();
        tree.reconcile(vec![
            spec("window", RetainedNodeKind::Window, None, &["stack"]),
            spec("stack", RetainedNodeKind::Column, Some("window"), &["a"]),
            spec("a", RetainedNodeKind::Text, Some("stack"), &[]),
        ])
        .expect("initial reconciliation");
        let original = tree.node("a").expect("a").instance_id;

        let diff = tree
            .reconcile(vec![
                spec("window", RetainedNodeKind::Window, None, &["stack"]),
                spec(
                    "stack",
                    RetainedNodeKind::Column,
                    Some("window"),
                    &["b", "a"],
                ),
                spec("b", RetainedNodeKind::Text, Some("stack"), &[]),
                spec("a", RetainedNodeKind::Text, Some("stack"), &[]),
            ])
            .expect("insert sibling");

        assert_eq!(tree.node("a").expect("a").instance_id, original);
        assert_eq!(diff.inserted, vec!["b"]);
        assert!(diff.retained.iter().any(|id| id == "a"));
        assert_eq!(diff.children_changed, vec!["stack"]);
    }

    #[test]
    fn conditional_is_retained_without_creating_a_layout_box() {
        let mut tree = RetainedTree::default();
        tree.reconcile(vec![
            spec("window", RetainedNodeKind::Window, None, &["branch"]),
            spec(
                "branch",
                RetainedNodeKind::Conditional,
                Some("window"),
                &["collapsed"],
            ),
            spec("collapsed", RetainedNodeKind::Action, Some("branch"), &[]),
        ])
        .expect("initial branch");
        let branch_instance = tree.node("branch").expect("branch").instance_id;

        let diff = tree
            .reconcile(vec![
                spec("window", RetainedNodeKind::Window, None, &["branch"]),
                spec(
                    "branch",
                    RetainedNodeKind::Conditional,
                    Some("window"),
                    &["expanded"],
                ),
                spec("expanded", RetainedNodeKind::Action, Some("branch"), &[]),
            ])
            .expect("switch branch");

        let branch = tree.node("branch").expect("branch");
        assert_eq!(branch.instance_id, branch_instance);
        assert!(!branch.has_layout_box());
        assert_eq!(diff.inserted, vec!["expanded"]);
        assert_eq!(diff.removed, vec!["collapsed"]);
        assert_eq!(diff.children_changed, vec!["branch"]);
    }

    #[test]
    fn semantic_kind_change_is_an_explicit_replacement() {
        let mut tree = RetainedTree::default();
        tree.reconcile(vec![spec("node", RetainedNodeKind::Text, None, &[])])
            .expect("text");
        let first = tree.node("node").expect("node").instance_id;

        let diff = tree
            .reconcile(vec![spec("node", RetainedNodeKind::Action, None, &[])])
            .expect("replacement");

        assert_eq!(diff.replaced, vec!["node"]);
        assert_ne!(tree.node("node").expect("node").instance_id, first);
    }

    #[test]
    fn child_reordering_preserves_instances() {
        let mut tree = RetainedTree::default();
        tree.reconcile(vec![
            spec("row", RetainedNodeKind::Row, None, &["a", "b"]),
            spec("a", RetainedNodeKind::Text, Some("row"), &[]),
            spec("b", RetainedNodeKind::Text, Some("row"), &[]),
        ])
        .expect("initial row");
        let a = tree.node("a").expect("a").instance_id;
        let b = tree.node("b").expect("b").instance_id;

        let diff = tree
            .reconcile(vec![
                spec("row", RetainedNodeKind::Row, None, &["b", "a"]),
                spec("b", RetainedNodeKind::Text, Some("row"), &[]),
                spec("a", RetainedNodeKind::Text, Some("row"), &[]),
            ])
            .expect("reordered row");

        assert_eq!(tree.node("a").expect("a").instance_id, a);
        assert_eq!(tree.node("b").expect("b").instance_id, b);
        assert_eq!(diff.children_changed, vec!["row"]);
        assert!(diff.inserted.is_empty());
        assert!(diff.removed.is_empty());
    }

    #[test]
    fn duplicate_active_semantic_identity_is_rejected() {
        let mut tree = RetainedTree::default();
        let error = tree
            .reconcile(vec![
                spec("same", RetainedNodeKind::Text, None, &[]),
                spec("same", RetainedNodeKind::Text, None, &[]),
            ])
            .expect_err("duplicate identity must fail");

        assert_eq!(
            error,
            RetainedTreeError::DuplicateIdentity("same".to_owned())
        );
    }
}
