// Adapt only this plugin's registrations; preserve the shared service and method receivers.
export function withToolRegistration(ctx, adapt) {
  const tools = new Proxy(ctx.tools, { get(target, key) {
    if (key === 'register') return definition => target.register(adapt(definition))
    const value = Reflect.get(target, key, target)
    return typeof value === 'function' ? value.bind(target) : value
  } })
  return new Proxy(ctx, { get(target, key) {
    if (key === 'tools') return tools
    const value = Reflect.get(target, key, target)
    return typeof value === 'function' ? value.bind(target) : value
  } })
}
