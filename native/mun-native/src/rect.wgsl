struct VertexOut {
    @builtin(position) position: vec4<f32>,
    @location(0) color: vec4<f32>,
    @location(1) local_position: vec2<f32>,
    @location(2) rect_size: vec2<f32>,
    @location(3) corner_radius: f32,
};

@vertex
fn vs_main(
    @location(0) position: vec2<f32>,
    @location(1) color: vec4<f32>,
    @location(2) local_position: vec2<f32>,
    @location(3) rect_size: vec2<f32>,
    @location(4) corner_radius: f32,
) -> VertexOut {
    var out: VertexOut;
    out.position = vec4<f32>(position, 0.0, 1.0);
    out.color = color;
    out.local_position = local_position;
    out.rect_size = rect_size;
    out.corner_radius = corner_radius;
    return out;
}

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4<f32> {
    let radius = clamp(
        in.corner_radius,
        0.0,
        max(0.0, min(in.rect_size.x, in.rect_size.y) * 0.5),
    );
    if (radius <= 0.0) {
        return in.color;
    }

    let half_size = in.rect_size * 0.5;
    let point = in.local_position - half_size;
    let q = abs(point) - half_size + vec2<f32>(radius);
    let distance = length(max(q, vec2<f32>(0.0)))
        + min(max(q.x, q.y), 0.0)
        - radius;
    let antialias = max(fwidth(distance), 0.5);
    let coverage = 1.0 - smoothstep(-antialias, antialias, distance);
    return vec4<f32>(in.color.rgb, in.color.a * coverage);
}
