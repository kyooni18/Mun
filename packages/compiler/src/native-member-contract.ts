// Static semantic member sets shared by lowering and editor intelligence.
export const horizontalAlignments = ['leading', 'center', 'trailing'] as const
export const verticalAlignments = ['top', 'center', 'bottom'] as const
export const overlayAlignments = ['center', 'leading', 'trailing', 'top', 'bottom', 'topLeading', 'topTrailing', 'bottomLeading', 'bottomTrailing'] as const
export const paddingEdges = {
  all: ['top', 'leading', 'bottom', 'trailing'],
  horizontal: ['leading', 'trailing'], vertical: ['top', 'bottom'],
  top: ['top'], bottom: ['bottom'], leading: ['leading'], trailing: ['trailing'],
} as const
