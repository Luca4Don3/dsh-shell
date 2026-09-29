window.__ModuleLoader__.load({
  id: 'dsh-shell',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const namespace = 'dshShell'
    const entryId = 'dsh-shell'

    const en = {
      title: 'Shell environment',
      shell: 'Shell',
      distribution: 'WSL distribution',
      loading: 'Loading available shells…',
      unavailable: 'Shell settings are unavailable.',
      noChoices: 'The host did not provide shell choices.',
      readOnly: 'This profile is read-only.',
      save: 'Save',
      saving: 'Saving…',
      saved: 'Saved. Restart DSH and start a new session to use this shell.',
      failed: 'The selection could not be saved. Check the current profile and try again.',
    }
    const zh = {
      title: 'Shell 环境',
      shell: 'Shell',
      distribution: 'WSL 发行版',
      loading: '正在读取本机可用的 Shell…',
      unavailable: 'Shell 配置暂不可用。',
      noChoices: 'Host 未提供可用的 Shell 选项。',
      readOnly: '当前 profile 为只读。',
      save: '保存',
      saving: '保存中…',
      saved: '已保存。重启 DSH 并新建会话后使用所选 Shell。',
      failed: '未能保存选择。请检查当前 profile 后重试。',
    }

    function choices(schema, field) {
      const refs = schema?.refs
      const root = refs?.[schema.uid]
      const union = refs?.[root?.dict?.[field]]
      if (union?.type !== 'union') return []
      return union.list.flatMap((id) => {
        const option = refs[id]
        return option?.type === 'const' && typeof option.value === 'string' ? [option.value] : []
      })
    }

    function operations(base, draft, shellOptions, distributions) {
      if (!shellOptions.includes(draft.shell)) throw new Error('Selected shell is unavailable')
      if (draft.shell === 'wsl' && !distributions.includes(draft.wslDistribution)) {
        throw new Error('Selected WSL distribution is unavailable')
      }
      const next = {
        shell: draft.shell,
        shellPath: draft.shell === base.shell ? base.shellPath ?? null : null,
        wslDistribution: draft.shell === 'wsl' ? draft.wslDistribution : null,
      }
      return Object.entries(next).flatMap(([field, value]) =>
        (base[field] ?? (field === 'shell' ? 'auto' : null)) === value
          ? [] : [{ op: 'set', path: [field], value }])
    }

    const inject = ['slots', 'configForms', 'locale']

    function apply(ctx) {
      const t = ctx.locale.bind(namespace)
      ctx.effect(() => ctx.locale.register(namespace, { en, zh }))
      const form = ctx.configForms.get(entryId)
      const mirror = ctx.configForms.describe()
      const subscribeForm = (listener) => form.subscribe(listener)
      const readForm = () => form.getSnapshot()
      const subscribeMirror = (listener) => mirror.subscribe(listener)
      const readMirror = () => mirror.getSnapshot()

      function ShellConfigPage() {
        const state = React.useSyncExternalStore(subscribeForm, readForm)
        const document = React.useSyncExternalStore(subscribeMirror, readMirror)
        const schema = document.view?.namespaces.find((row) => row.ns === entryId)?.schema
        const shellOptions = choices(schema, 'shell')
        const distributions = choices(schema, 'wslDistribution')
        const [draft, setDraft] = React.useState(null)
        const [saving, setSaving] = React.useState(false)
        const [message, setMessage] = React.useState('')

        React.useEffect(() => {
          if (draft !== null || state.status !== 'ready' || !shellOptions.length) return
          setDraft({
            revision: state.revision,
            base: state.value,
            shell: state.value.shell ?? 'auto',
            wslDistribution: state.value.wslDistribution || distributions[0] || '',
          })
        }, [draft, state, shellOptions.length, distributions.length])

        if (state.status !== 'ready') return h('p', { role: 'status' }, t(state.status === 'loading' ? 'loading' : 'unavailable'))
        if (!shellOptions.length || draft === null) return h('p', { role: 'status' }, t(shellOptions.length ? 'loading' : 'noChoices'))

        let edits = []
        try {
          edits = operations(draft.base, draft, shellOptions, distributions)
        } catch {}
        const canSave = state.writable && !saving && edits.length > 0 && shellOptions.includes(draft.shell)
          && (draft.shell !== 'wsl' || distributions.includes(draft.wslDistribution))
        const fieldStyle = { display: 'grid', gap: 6 }
        const inputStyle = { width: '100%', padding: '8px 10px', color: 'inherit', background: 'transparent' }

        const save = async () => {
          if (!canSave) return
          setSaving(true)
          setMessage('')
          try {
            const accepted = await form.mutate(edits, draft.revision)
            if (!accepted) {
              setMessage(t('failed'))
              return
            }
            setDraft(null)
            setMessage(t('saved'))
          } catch {
            setMessage(t('failed'))
          } finally {
            setSaving(false)
          }
        }

        return h('div', { style: { display: 'grid', gap: 14, maxWidth: 480 } },
          h('h3', { style: { margin: 0 } }, t('title')),
          h('label', { style: fieldStyle }, t('shell'), h('select', {
            value: draft.shell,
            disabled: saving || !state.writable,
            style: inputStyle,
            onChange: (event) => {
              const shell = event.target.value
              setDraft({ ...draft, shell,
                wslDistribution: shell === 'wsl' ? draft.wslDistribution || distributions[0] || '' : '' })
              setMessage('')
            },
          }, shellOptions.map((shell) => h('option', { key: shell, value: shell }, shell)))),
          draft.shell === 'wsl' && distributions.length > 0
            ? h('label', { style: fieldStyle }, t('distribution'), h('select', {
              value: draft.wslDistribution,
              disabled: saving || !state.writable,
              style: inputStyle,
              onChange: (event) => {
                setDraft({ ...draft, wslDistribution: event.target.value })
                setMessage('')
              },
            }, distributions.map((name) => h('option', { key: name, value: name }, name))))
            : null,
          !state.writable ? h('p', { role: 'status' }, t('readOnly')) : null,
          h('div', null, h('button', { type: 'button', disabled: !canSave, onClick: save }, t(saving ? 'saving' : 'save'))),
          message ? h('p', { role: 'status' }, message) : null)
      }

      ctx.effect(() => ctx.configForms.whileServed([entryId], () =>
        ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
          name: 'plugins.bundle.config',
          key: 'dsh-shell',
          locale: namespace,
        }, ShellConfigPage))))
    }

    return { apply, inject, choices, operations }
  },
})
