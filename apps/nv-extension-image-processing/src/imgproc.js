/**
 * Example: using @niivue/nv-image-processing extensions via the extension context.
 *
 * Demonstrates registering external volume transforms and running them
 * through the NVExtensionContext API. All heavy computation runs in a Web Worker.
 */
import NiiVue from "@niivue/niivue"
import {
  conform,
  connectedLabel,
  otsu,
  removeHaze,
} from "@niivue/nv-image-processing"

// --- Create dialog for transform options ---
const dialog = document.createElement("dialog")
dialog.id = "transformDialog"
dialog.innerHTML = `
  <form method="dialog">
    <h3 id="dialogTitle">Options</h3>
    <div id="dialogFields"></div>
    <div style="margin-top: 1em; display: flex; gap: 0.5em; justify-content: flex-end;">
      <button type="button" id="cancelBtn">Cancel</button>
      <button type="submit" id="applyBtn">Apply</button>
    </div>
  </form>
`
document.body.appendChild(dialog)
dialog.querySelector("#cancelBtn").onclick = () => dialog.close()

// --- Initialize NiiVue ---
const nv = new NiiVue()
const ctx = nv.createExtensionContext()

// Register external image-processing transforms
ctx.registerVolumeTransform(conform)
ctx.registerVolumeTransform(connectedLabel)
ctx.registerVolumeTransform(otsu)
ctx.registerVolumeTransform(removeHaze)

function buildDialogFields(transformName) {
  const info = nv.getVolumeTransformInfo(transformName)
  const fieldsDiv = dialog.querySelector("#dialogFields")
  dialog.querySelector("#dialogTitle").textContent = info
    ? info.description
    : transformName
  fieldsDiv.innerHTML = ""
  if (!info?.options.length) {
    fieldsDiv.innerHTML = "<p>No configurable options.</p>"
    return
  }
  for (const field of info.options) {
    const div = document.createElement("div")
    div.style.marginBottom = "0.5em"
    if (field.type === "checkbox") {
      const input = document.createElement("input")
      input.type = "checkbox"
      input.id = `opt_${field.name}`
      input.checked = field.default
      const label = document.createElement("label")
      label.htmlFor = input.id
      label.textContent = ` ${field.label}`
      div.appendChild(input)
      div.appendChild(label)
    } else if (field.type === "select") {
      const label = document.createElement("label")
      label.htmlFor = `opt_${field.name}`
      label.textContent = `${field.label}: `
      const select = document.createElement("select")
      select.id = `opt_${field.name}`
      for (const opt of field.options) {
        const option = document.createElement("option")
        option.value = opt
        option.textContent = String(opt)
        if (opt === field.default) option.selected = true
        select.appendChild(option)
      }
      div.appendChild(label)
      div.appendChild(select)
    }
    fieldsDiv.appendChild(div)
  }
}

function getDialogOptions(transformName) {
  const info = nv.getVolumeTransformInfo(transformName)
  if (!info) return {}
  const options = {}
  for (const field of info.options) {
    const el = dialog.querySelector(`#opt_${field.name}`)
    if (!el) continue
    if (field.type === "checkbox") {
      options[field.name] = el.checked
    } else if (field.type === "select") {
      options[field.name] = field.options.includes(parseInt(el.value, 10))
        ? parseInt(el.value, 10)
        : el.value
    }
  }
  return options
}

// --- UI wiring ---
const status = document.getElementById("status")
const sliceType = document.getElementById("sliceType")
const transformSelect = document.getElementById("transformSelect")
const resetBtn = document.getElementById("resetBtn")

sliceType.onchange = () => {
  nv.sliceType = parseInt(sliceType.value, 10)
}

transformSelect.onchange = function () {
  const name = this.value
  if (!name) return
  buildDialogFields(name)
  dialog.showModal()
  dialog.querySelector("form").onsubmit = async (e) => {
    e.preventDefault()
    const opts = getDialogOptions(name)
    dialog.close()
    await runTransform(name, opts)
    transformSelect.selectedIndex = 0
  }
}

resetBtn.onclick = async () => {
  await ctx.removeAllVolumes()
  await nv.loadVolumes([{ url: "/volumes/mni152.nii.gz" }])
  status.textContent = ""
}

async function runTransform(name, options) {
  const vol = ctx.volumes[0]
  if (!vol) return
  status.textContent = `Running ${name}…`
  const t0 = performance.now()
  const result = await ctx.applyVolumeTransform(name, vol, options)
  const elapsed = (performance.now() - t0).toFixed(0)

  // Apply plugin-defined display defaults
  const info = nv.getVolumeTransformInfo(name)
  if (info?.resultDefaults) {
    if (info.resultDefaults.colormap)
      result.colormap = info.resultDefaults.colormap
    if (info.resultDefaults.opacity != null)
      result.opacity = info.resultDefaults.opacity
  }

  // For removeHaze, replace the volume; for segmentations, add as overlay
  if (name === "removeHaze") {
    await ctx.removeAllVolumes()
    await ctx.addVolume(result)
    status.textContent = `removeHaze done in ${elapsed} ms (worker)`
  } else {
    await ctx.addVolume(result)
    status.textContent = `${name} done in ${elapsed} ms (worker) — added as overlay`
  }
}

ctx.on("locationChange", (e) => {
  document.getElementById("location").innerHTML =
    `&nbsp;&nbsp;${e.detail.string}`
})

await nv.attachToCanvas(document.getElementById("gl1"))
sliceType.onchange()

// Populate the dropdown
const emptyOpt = document.createElement("option")
emptyOpt.value = ""
emptyOpt.textContent = "— select —"
transformSelect.appendChild(emptyOpt)
for (const tf of [
  conform.name,
  connectedLabel.name,
  otsu.name,
  removeHaze.name,
]) {
  const option = document.createElement("option")
  option.value = tf
  option.textContent = tf
  transformSelect.appendChild(option)
}

await nv.loadVolumes([{ url: "/volumes/mni152.nii.gz" }])
