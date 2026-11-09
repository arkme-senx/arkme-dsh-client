# The only result consumed by NSIS is an explicit retry. The reason is plain text.
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[Windows.Forms.Application]::EnableVisualStyles()
$form = New-Object Windows.Forms.Form
$form.Text = '即我更新未完成'
$form.StartPosition = 'CenterScreen'
$form.AutoScaleMode = 'Dpi'
$form.ClientSize = New-Object Drawing.Size(510,244)
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.Font = New-Object Drawing.Font('Microsoft YaHei UI',10)
$reason = New-Object Windows.Forms.TextBox
$reason.Multiline = $true
$reason.ReadOnly = $true
$reason.ScrollBars = 'Vertical'
$reason.Text = $env:JIWO_UPDATE_ERROR
$reason.SetBounds(18,18,474,152)
$form.Controls.Add($reason)
$retry = New-Object Windows.Forms.Button
$retry.Text = '重试安装'
$retry.SetBounds(232,190,110,36)
$retry.DialogResult = 'Retry'
$form.Controls.Add($retry)
$download = New-Object Windows.Forms.Button
$download.Text = '下载完整安装包'
$download.SetBounds(350,190,142,36)
$download.Add_Click({ Start-Process 'https://jiwo.cc' })
$form.Controls.Add($download)
$form.ActiveControl = $retry
if ($form.ShowDialog() -eq 'Retry') { exit 4 }
exit 0
