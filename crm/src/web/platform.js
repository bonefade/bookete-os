export function copyText(txt) {
  let ok = false;
  const ta = document.createElement("textarea");
  ta.value = txt;
  ta.setAttribute("readonly", "");
  ta.style.cssText = "position:fixed;top:0;left:0;opacity:0;";
  document.body.appendChild(ta);
  ta.select();
  ta.setSelectionRange(0, txt.length);
  try {
    ok = document.execCommand("copy");
  } catch (e) {
  }
  ta.remove();
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(txt).catch(() => {
    });
    ok = true;
  }
  return ok;
}
export const mailSubject = (lead) => "bookete \u2013 Tischreservierung f\xFCr " + lead.name;
export function channelLink(lead, channel, text = "") {
  const ig = (lead.instagram || "").replace(/^@/, "").trim();
  const phone = ((lead.phone || "").match(/\+?\d[\d\s/()-]{5,}\d/) || [""])[0].replace(/[^\d+]/g, "");
  const email = ((lead.email || "").match(/[\w.+-]+@[\w-]+\.[\w.-]+/) || [""])[0];
  switch (channel) {
    case "Instagram":
      return ig ? "https://ig.me/m/" + encodeURIComponent(ig) : "";
    case "E-Mail":
      return email ? `mailto:${email}?subject=${encodeURIComponent(mailSubject(lead))}&body=${encodeURIComponent(text)}` : "";
    case "WhatsApp":
      return phone ? `https://wa.me/${phone.replace("+", "")}?text=${encodeURIComponent(text)}` : "";
    case "Telefon":
      return phone ? "tel:" + phone : "";
    default:
      return "";
  }
}
export const instagramProfile = (lead) => {
  const ig = (lead.instagram || "").replace(/^@/, "").trim();
  return ig ? `https://www.instagram.com/${ig}/` : "";
};
export function saveFile(filename, text) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1e3);
}
