// A toolbar <select> for a page setting held in the URL, such as ?backend=
// (#488): it shows the value in effect (the backend actually running, after
// any fallback) and reloads the page with the new value, since a page builds
// its renderer once.
export function urlParamSelect(select, name, value) {
  select.value = value
  select.onchange = () => {
    const url = new URL(location.href)
    url.searchParams.set(name, select.value)
    location.href = url.href
  }
}
