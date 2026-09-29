import { defineComponent } from 'vue'
import { Text } from '../packages/core/dist/compat.js'
import { Component, vueComponent } from '../packages/vue/src/index.js'

const RequiredBadge = defineComponent({
  props: {
    label: { type: String, required: true },
    count: { type: Number, required: false },
  },
  emits: { save: (_value: string) => true },
  setup: () => () => null,
})

Component(RequiredBadge, { label: 'Mun', onSave: value => value.toUpperCase() })
Component(RequiredBadge, { label: 'Mun', slots: { default: () => Text('Body'), row: ({ label }) => Text(String(label)) } })
const Badge = vueComponent(RequiredBadge)
Badge({ label: 'Mun', onSave: value => value.toUpperCase() })
// @ts-expect-error required Vue component prop is missing
Component(RequiredBadge, {})
// @ts-expect-error Vue component prop type must match
Component(RequiredBadge, { label: 42 })
// @ts-expect-error declared Vue emit payload is a string
Component(RequiredBadge, { label: 'Mun', onSave: (value: number) => value })
// @ts-expect-error adapted Vue components retain required props
Badge({})
