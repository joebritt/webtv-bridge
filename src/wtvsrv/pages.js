// Pages served by the in-page WebTV service, in the WebTV client's HTML dialect. Images and
// sounds come from the box's own ROM (file://ROM/...), so the service needs no assets.

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function frame(title, body, { display = '', refresh = null } = {}) {
  return `<html>
<head>
<title>${esc(title)}</title>${refresh ? `\n<meta http-equiv=Refresh content="1; url=${esc(refresh)}">` : ''}
<display ${display}>
</head>
<body bgcolor="#191919" text="#cbcbcb" link="#ffcf69" vlink="#ffcf69" fontsize="medium" hspace=0 vspace=0>
<table cellspacing=0 cellpadding=0 width=560>
<tr><td height=16>
<tr><td width=24><td>
<font size=+2 color="#ffcf69"><shadow><b>${esc(title)}</b></shadow></font>
<tr><td height=12>
<tr><td><td>
${body}
</table>
</body>
</html>`;
}

const button = (label, attrs = '') => `<input type=submit value="${esc(label)}" borderimage="file://ROM/Borders/ButtonBorder2.bif" usestyle width=150 ${attrs}>`;

export function splash(service, next) {
  return `<html>
<head>
<display hideoptions nostatus showwhencomplete skipback clearback fontsize=medium>
<title>${esc(service)}</title>
<meta http-equiv=Refresh content="2; url=${next}">
</head>
<body bgcolor="#000000" text="#449944">
<center>
<spacer type=block height=150 width=1><br>
<font size=+3 color="#ffcf69"><shadow><b>${esc(service)}</b></shadow></font>
<p>
<font color="#7f9f7f">Connected at &rate;</font>
</center>
</body>
</html>`;
}

export function message(title, text) {
  return frame(title, `<p>${esc(text)}</p>`);
}

export function register(service, q, error = null) {
  return frame(`Welcome to ${service}`, `
${error ? `<p><font color="#ff7766">${esc(error)}</font></p>` : `<p>This box isn't set up yet. Choose a name and a username to finish setting it up.</p>`}
<form action="wtv-register:/ValidateAccountInfo" method="POST">
<table cellspacing=0 cellpadding=4>
<tr><td><font color="#ffcf69">Your name</font>
<td><input name="subscriber_name" value="${esc(q.subscriber_name || '')}" size=20 maxlength=32 bgcolor=#444444 text=#ffdd33 cursor=#cc9933 autocaps selected>
<tr><td><font color="#ffcf69">Username</font>
<td><input name="subscriber_username" value="${esc(q.subscriber_username || '')}" size=20 maxlength=16 bgcolor=#444444 text=#ffdd33 cursor=#cc9933>
</table>
<p>
${button('Continue', 'name=Continue')}
</form>`, { display: 'nooptions noscroll' });
}

export function registered(service, name, user) {
  return frame('All set', `
<p>Thanks, ${esc(name)}. This box is now registered with ${esc(service)} as <b>${esc(user)}</b>.</p>
<p>Choose Continue to log in.</p>
<form action="wtv-register:/FinishRegistration">
${button('Continue', 'selected')}
</form>`, { display: 'nooptions noscroll' });
}

export function home(service, d, visit = null) {
  const name = d.subscriber_name || d.subscriber_username || 'there';
  return frame(`${service} Home`, `
<p>Hello, ${esc(name)}.</p>
<form action="client:goto">
<table cellspacing=0 cellpadding=0><tr><td>
<input name="url" value="http://" size=34 bgcolor=#444444 text=#ffdd33 cursor=#cc9933 selected>
<td width=8><td>${button('Go to page', 'width=130')}
</table>
</form>
<p>
<table cellspacing=0 cellpadding=6>
<tr><td><a href="http://frogfind.com/">FrogFind</a><td><font size=-1 color="#8f8f8f">search the web, made for old browsers</font>
<tr><td><a href="http://68k.news/">68k.news</a><td><font size=-1 color="#8f8f8f">headlines, simply formatted</font>
<tr><td><a href="file://ROM/tvhtmls/setup.html">Settings</a><td><font size=-1 color="#8f8f8f">the box's own setup pages</font>
<tr><td><a href="client:showdir?theDir=/">Disk</a><td><font size=-1 color="#8f8f8f">browse the box's disk (debug builds)</font>
</table>
<p><font size=-1 color="#8f8f8f">Served by the emulator's built-in service.</font></p>`, { refresh: visit });
}
