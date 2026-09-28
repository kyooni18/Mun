use std::collections::HashMap;

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Rect {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

impl Rect {
    pub fn contains(self, x: f32, y: f32) -> bool {
        x >= self.x && y >= self.y && x <= self.x + self.width && y <= self.y + self.height
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SceneTransform {
    pub scale_x: f32,
    pub scale_y: f32,
    pub translation_x: f32,
    pub translation_y: f32,
}

impl Default for SceneTransform {
    fn default() -> Self {
        Self::IDENTITY
    }
}

impl SceneTransform {
    pub const IDENTITY: Self = Self {
        scale_x: 1.0,
        scale_y: 1.0,
        translation_x: 0.0,
        translation_y: 0.0,
    };

    pub const fn translation(x: f32, y: f32) -> Self {
        Self {
            translation_x: x,
            translation_y: y,
            ..Self::IDENTITY
        }
    }

    pub const fn scale(scale_x: f32, scale_y: f32) -> Self {
        Self {
            scale_x,
            scale_y,
            ..Self::IDENTITY
        }
    }

    pub fn scale_about(pivot_x: f32, pivot_y: f32, scale_x: f32, scale_y: f32) -> Self {
        Self {
            scale_x,
            scale_y,
            translation_x: pivot_x * (1.0 - scale_x),
            translation_y: pivot_y * (1.0 - scale_y),
        }
    }

    /// Composes a child-local transform under this parent transform.
    ///
    /// The returned transform applies `child` first, then `self`.
    pub fn concat(self, child: Self) -> Self {
        Self {
            scale_x: self.scale_x * child.scale_x,
            scale_y: self.scale_y * child.scale_y,
            translation_x: self.translation_x + self.scale_x * child.translation_x,
            translation_y: self.translation_y + self.scale_y * child.translation_y,
        }
    }

    pub fn transform_point(self, x: f32, y: f32) -> (f32, f32) {
        (
            x * self.scale_x + self.translation_x,
            y * self.scale_y + self.translation_y,
        )
    }

    pub fn transform_rect(self, rect: Rect) -> Rect {
        let (x0, y0) = self.transform_point(rect.x, rect.y);
        let (x1, y1) = self.transform_point(rect.x + rect.width, rect.y + rect.height);
        Rect {
            x: x0.min(x1),
            y: y0.min(y1),
            width: (x1 - x0).abs(),
            height: (y1 - y0).abs(),
        }
    }

    pub fn inverse(self) -> Option<Self> {
        if self.scale_x.abs() <= f32::EPSILON || self.scale_y.abs() <= f32::EPSILON {
            return None;
        }
        Some(Self {
            scale_x: self.scale_x.recip(),
            scale_y: self.scale_y.recip(),
            translation_x: -self.translation_x / self.scale_x,
            translation_y: -self.translation_y / self.scale_y,
        })
    }

    pub fn is_identity(self) -> bool {
        self == Self::IDENTITY
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct SceneTransformId(usize);

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SceneTransformNode {
    pub parent: Option<SceneTransformId>,
    pub local: SceneTransform,
}

/// Renderer-neutral presentation transforms layered over retained scene geometry.
///
/// Primitive geometry remains in Taffy's logical scene space. Bindings associate
/// primitive IDs with transform nodes, and transform nodes can inherit from a
/// parent so subtree motion can be represented without baking presentation
/// scale/translation into every rectangle or text metric.
#[derive(Clone, Debug, Default)]
pub struct ScenePresentation {
    transforms: Vec<SceneTransformNode>,
    bindings: HashMap<String, SceneTransformId>,
}

impl ScenePresentation {
    pub fn push_transform(
        &mut self,
        parent: Option<SceneTransformId>,
        local: SceneTransform,
    ) -> SceneTransformId {
        if let Some(parent) = parent {
            assert!(
                parent.0 < self.transforms.len(),
                "scene transform parent must already exist"
            );
        }
        let id = SceneTransformId(self.transforms.len());
        self.transforms.push(SceneTransformNode { parent, local });
        id
    }

    pub fn bind(&mut self, primitive_id: impl Into<String>, transform: SceneTransformId) {
        assert!(
            transform.0 < self.transforms.len(),
            "scene primitive cannot bind an unknown transform"
        );
        self.bindings.insert(primitive_id.into(), transform);
    }

    pub fn unbind(&mut self, primitive_id: &str) {
        self.bindings.remove(primitive_id);
    }

    pub fn transform_for(&self, primitive_id: &str) -> SceneTransform {
        self.bindings
            .get(primitive_id)
            .copied()
            .map(|id| self.resolved_transform(id))
            .unwrap_or(SceneTransform::IDENTITY)
    }

    pub fn resolved_transform(&self, transform: SceneTransformId) -> SceneTransform {
        let mut current = transform;
        let mut chain = Vec::new();
        loop {
            let node = self
                .transforms
                .get(current.0)
                .expect("scene primitive referenced an unknown transform");
            chain.push(node.local);
            let Some(parent) = node.parent else {
                break;
            };
            current = parent;
        }

        chain
            .into_iter()
            .rev()
            .fold(SceneTransform::IDENTITY, SceneTransform::concat)
    }

    pub fn transformed_rect(&self, primitive_id: &str, rect: Rect) -> Rect {
        self.transform_for(primitive_id).transform_rect(rect)
    }

    pub fn action_at<'a>(&self, scene: &'a Scene, x: f32, y: f32) -> Option<&'a str> {
        scene
            .actions
            .iter()
            .rev()
            .find(|action| {
                let transform = self.transform_for(&action.id);
                let Some(inverse) = transform.inverse() else {
                    return false;
                };
                let (local_x, local_y) = inverse.transform_point(x, y);
                action.rect.contains(local_x, local_y)
            })
            .map(|action| action.id.as_str())
    }

    pub fn is_empty(&self) -> bool {
        self.bindings.is_empty()
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Color(pub [f32; 4]);

impl Color {
    pub const WINDOW: Self = Self([0.075, 0.075, 0.09, 1.0]);
    pub const TEXT: Self = Self([0.94, 0.94, 0.97, 1.0]);
    pub const ACTION: Self = Self([0.18, 0.18, 0.22, 1.0]);
    pub const ACTION_FOCUSED: Self = Self([0.28, 0.28, 0.34, 1.0]);

    pub fn with_opacity(mut self, opacity: f32) -> Self {
        self.0[3] *= opacity.clamp(0.0, 1.0);
        self
    }

    pub fn parse(value: &str) -> Option<Self> {
        let hex = value.strip_prefix('#')?;
        let parse = |range: std::ops::Range<usize>| u8::from_str_radix(&hex[range], 16).ok();
        match hex.len() {
            6 => Some(Self([
                parse(0..2)? as f32 / 255.0,
                parse(2..4)? as f32 / 255.0,
                parse(4..6)? as f32 / 255.0,
                1.0,
            ])),
            8 => Some(Self([
                parse(0..2)? as f32 / 255.0,
                parse(2..4)? as f32 / 255.0,
                parse(4..6)? as f32 / 255.0,
                parse(6..8)? as f32 / 255.0,
            ])),
            _ => None,
        }
    }
}

#[derive(Clone, Debug)]
pub struct SceneRect {
    pub id: String,
    pub rect: Rect,
    pub color: Color,
    pub corner_radius: f32,
}

#[derive(Clone, Debug)]
pub struct SceneText {
    pub id: String,
    pub text: String,
    pub x: f32,
    pub y: f32,
    pub font_size: f32,
    pub color: Color,
}

#[derive(Clone, Debug)]
pub struct ActionHit {
    pub id: String,
    pub rect: Rect,
}

#[derive(Clone, Debug, Default)]
pub struct Scene {
    pub rects: Vec<SceneRect>,
    pub texts: Vec<SceneText>,
    pub actions: Vec<ActionHit>,
}

impl Scene {
    pub fn action_at(&self, x: f32, y: f32) -> Option<&str> {
        self.actions
            .iter()
            .rev()
            .find(|action| action.rect.contains(x, y))
            .map(|action| action.id.as_str())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_point(actual: (f32, f32), expected: (f32, f32)) {
        assert!(
            (actual.0 - expected.0).abs() < 0.0001,
            "{actual:?} != {expected:?}"
        );
        assert!(
            (actual.1 - expected.1).abs() < 0.0001,
            "{actual:?} != {expected:?}"
        );
    }

    #[test]
    fn transform_composition_applies_child_before_parent() {
        let parent = SceneTransform {
            scale_x: 2.0,
            scale_y: 3.0,
            translation_x: 4.0,
            translation_y: -5.0,
        };
        let child = SceneTransform::translation(6.0, 7.0);
        let combined = parent.concat(child);

        assert_point(combined.transform_point(1.0, 2.0), (18.0, 22.0));
    }

    #[test]
    fn nested_scene_transforms_resolve_in_hierarchy_order() {
        let mut presentation = ScenePresentation::default();
        let parent = presentation.push_transform(None, SceneTransform::scale(2.0, 3.0));
        let child =
            presentation.push_transform(Some(parent), SceneTransform::translation(5.0, 7.0));
        presentation.bind("label", child);

        assert_point(
            presentation
                .transform_for("label")
                .transform_point(1.0, 2.0),
            (12.0, 27.0),
        );
    }

    #[test]
    fn non_uniform_scale_about_pivot_keeps_pivot_fixed() {
        let transform = SceneTransform::scale_about(10.0, 20.0, 2.0, 0.5);

        assert_point(transform.transform_point(10.0, 20.0), (10.0, 20.0));
        assert_point(transform.transform_point(11.0, 22.0), (12.0, 21.0));
    }

    #[test]
    fn transformed_action_hit_testing_uses_presentation_geometry() {
        let scene = Scene {
            actions: vec![ActionHit {
                id: "button".into(),
                rect: Rect {
                    x: 10.0,
                    y: 20.0,
                    width: 30.0,
                    height: 20.0,
                },
            }],
            ..Default::default()
        };
        let mut presentation = ScenePresentation::default();
        let transform = presentation.push_transform(
            None,
            SceneTransform {
                scale_x: 2.0,
                scale_y: 0.5,
                translation_x: 5.0,
                translation_y: 3.0,
            },
        );
        presentation.bind("button", transform);

        assert_eq!(presentation.action_at(&scene, 45.0, 15.5), Some("button"));
        assert_eq!(presentation.action_at(&scene, 4.0, 15.5), None);
    }
}
