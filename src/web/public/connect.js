// Copy buttons: <button data-copy="id-of-input">. Falls back to selecting the text.
for (const button of document.querySelectorAll('[data-copy]')) {
  button.addEventListener('click', async () => {
    const field = document.getElementById(button.dataset.copy)
    const status = document.getElementById('copy-status')
    try {
      await navigator.clipboard.writeText(field.value)
      button.textContent = 'Copied'
      setTimeout(() => { button.textContent = 'Copy' }, 2000)
      if (status && field.id === 'mcp-url') status.textContent = 'Copied. Paste it into your assistant’s connector settings.'
    } catch {
      field.focus()
      field.select()
      if (status) status.textContent = 'Press Ctrl+C or ⌘C to copy the selected text.'
    }
  })
}

// Selecting a read-only field's text on focus makes manual copying one step.
for (const field of document.querySelectorAll('.copy-field input')) {
  field.addEventListener('focus', () => field.select())
}
