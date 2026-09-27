# Rust3D installer: one window, one button. Puts the Rust3D panel into After Effects and
# Premiere Pro, downloads AssetStudioModCLI + FBX2glTF and finds Rust and Blender.
# -Update first pulls the latest version of this repository from GitHub.
param([switch]$Update)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase
Add-Type -AssemblyName System.IO.Compression.FileSystem
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Repo    = 'M1tr0y/test'
$Root    = Split-Path -Parent $PSScriptRoot
$AppDir  = Join-Path $env:APPDATA 'Rust3D'
$Tools   = Join-Path $AppDir 'tools'
$CepDir  = Join-Path $env:APPDATA 'Adobe\CEP\extensions'
$PanelId = 'com.rust3d.panel'
$script:finished = $false

[xml]$xaml = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="Rust3D" Width="500" SizeToContent="Height" WindowStyle="None" AllowsTransparency="True"
        Background="Transparent" WindowStartupLocation="CenterScreen" ResizeMode="NoResize"
        FontFamily="Bahnschrift, Segoe UI" Foreground="#ECE4D8">
  <Window.Resources>
    <Style x:Key="Primary" TargetType="Button">
      <Setter Property="Foreground" Value="White"/>
      <Setter Property="FontSize" Value="15"/>
      <Setter Property="FontWeight" Value="Bold"/>
      <Setter Property="Cursor" Value="Hand"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="Button">
            <Border x:Name="Bd" CornerRadius="10" Height="50">
              <Border.Background>
                <LinearGradientBrush StartPoint="0,0" EndPoint="0,1">
                  <GradientStop Color="#E8703F" Offset="0"/>
                  <GradientStop Color="#CE422B" Offset="1"/>
                </LinearGradientBrush>
              </Border.Background>
              <Border.Effect>
                <DropShadowEffect Color="#CE422B" BlurRadius="22" ShadowDepth="0" Opacity="0.4"/>
              </Border.Effect>
              <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center"/>
            </Border>
            <ControlTemplate.Triggers>
              <Trigger Property="IsMouseOver" Value="True">
                <Setter TargetName="Bd" Property="Effect">
                  <Setter.Value>
                    <DropShadowEffect Color="#E8703F" BlurRadius="32" ShadowDepth="0" Opacity="0.85"/>
                  </Setter.Value>
                </Setter>
              </Trigger>
              <Trigger Property="IsPressed" Value="True">
                <Setter TargetName="Bd" Property="Opacity" Value="0.85"/>
              </Trigger>
              <Trigger Property="IsEnabled" Value="False">
                <Setter TargetName="Bd" Property="Opacity" Value="0.5"/>
              </Trigger>
            </ControlTemplate.Triggers>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>
    <Style x:Key="Ghost" TargetType="Button">
      <Setter Property="Foreground" Value="#8E8478"/>
      <Setter Property="Cursor" Value="Hand"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="Button">
            <Border x:Name="Bd" Background="Transparent" CornerRadius="6" Width="30" Height="30">
              <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center"/>
            </Border>
            <ControlTemplate.Triggers>
              <Trigger Property="IsMouseOver" Value="True">
                <Setter TargetName="Bd" Property="Background" Value="#26221E"/>
                <Setter Property="Foreground" Value="#ECE4D8"/>
              </Trigger>
            </ControlTemplate.Triggers>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>
  </Window.Resources>

  <Border x:Name="Card" CornerRadius="16" BorderBrush="#37302A" BorderThickness="1" Opacity="0" RenderTransformOrigin="0.5,0.5">
    <Border.RenderTransform>
      <ScaleTransform ScaleX="0.96" ScaleY="0.96"/>
    </Border.RenderTransform>
    <Border.Background>
      <RadialGradientBrush Center="0.9,0" GradientOrigin="0.9,0" RadiusX="1" RadiusY="0.9">
        <GradientStop Color="#3B1B12" Offset="0"/>
        <GradientStop Color="#161412" Offset="0.75"/>
      </RadialGradientBrush>
    </Border.Background>
    <Grid Margin="30,12,30,28">
      <Grid.RowDefinitions>
        <RowDefinition Height="Auto"/>
        <RowDefinition Height="Auto"/>
        <RowDefinition Height="Auto"/>
        <RowDefinition Height="Auto"/>
        <RowDefinition Height="Auto"/>
        <RowDefinition Height="Auto"/>
        <RowDefinition Height="Auto"/>
      </Grid.RowDefinitions>

      <Button x:Name="CloseBtn" Grid.Row="0" Style="{StaticResource Ghost}" HorizontalAlignment="Right" Margin="0,0,-18,0" Content="✕" FontSize="13"/>

      <StackPanel Grid.Row="1" Orientation="Horizontal" HorizontalAlignment="Center">
        <Border Width="46" Height="46" CornerRadius="9" Margin="0,0,14,0">
          <Border.Background>
            <LinearGradientBrush StartPoint="0,0" EndPoint="1,1">
              <GradientStop Color="#CE422B" Offset="0"/>
              <GradientStop Color="#8F2716" Offset="1"/>
            </LinearGradientBrush>
          </Border.Background>
          <Border.Effect>
            <DropShadowEffect Color="#CE422B" BlurRadius="22" ShadowDepth="0" Opacity="0.55"/>
          </Border.Effect>
          <TextBlock Text="R" FontSize="26" FontWeight="Bold" Foreground="White" HorizontalAlignment="Center" VerticalAlignment="Center"/>
        </Border>
        <TextBlock FontSize="34" FontWeight="Bold" VerticalAlignment="Center"><Run Text="RUST "/><Run Text="3D" Foreground="#CE422B"/></TextBlock>
      </StackPanel>

      <TextBlock x:Name="Subtitle" Grid.Row="2" HorizontalAlignment="Center" Margin="0,10,0,24" Foreground="#8E8478" FontSize="13"
                 Text="Модели из Rust в After Effects и Premiere Pro"/>

      <StackPanel Grid.Row="3">
        <Grid x:Name="UpdRow" Margin="0,0,0,12" Visibility="Collapsed">
          <Grid.ColumnDefinitions><ColumnDefinition Width="30"/><ColumnDefinition/></Grid.ColumnDefinitions>
          <TextBlock x:Name="Icon4" Text="○" Foreground="#5A5047" FontSize="15" VerticalAlignment="Center"/>
          <TextBlock x:Name="Text4" Grid.Column="1" Text="Свежая версия с GitHub" Foreground="#8E8478" FontSize="14" VerticalAlignment="Center"/>
        </Grid>
        <Grid Margin="0,0,0,12">
          <Grid.ColumnDefinitions><ColumnDefinition Width="30"/><ColumnDefinition/></Grid.ColumnDefinitions>
          <TextBlock x:Name="Icon0" Text="○" Foreground="#5A5047" FontSize="15" VerticalAlignment="Center"/>
          <TextBlock x:Name="Text0" Grid.Column="1" Text="Панель в After Effects и Premiere Pro" Foreground="#8E8478" FontSize="14" VerticalAlignment="Center"/>
        </Grid>
        <Grid Margin="0,0,0,12">
          <Grid.ColumnDefinitions><ColumnDefinition Width="30"/><ColumnDefinition/></Grid.ColumnDefinitions>
          <TextBlock x:Name="Icon1" Text="○" Foreground="#5A5047" FontSize="15" VerticalAlignment="Center"/>
          <TextBlock x:Name="Text1" Grid.Column="1" Text="AssetStudio — достаёт модели из игры" Foreground="#8E8478" FontSize="14" VerticalAlignment="Center"/>
        </Grid>
        <Grid Margin="0,0,0,12">
          <Grid.ColumnDefinitions><ColumnDefinition Width="30"/><ColumnDefinition/></Grid.ColumnDefinitions>
          <TextBlock x:Name="Icon2" Text="○" Foreground="#5A5047" FontSize="15" VerticalAlignment="Center"/>
          <TextBlock x:Name="Text2" Grid.Column="1" Text="Конвертер FBX → GLB" Foreground="#8E8478" FontSize="14" VerticalAlignment="Center"/>
        </Grid>
        <Grid Margin="0,0,0,12">
          <Grid.ColumnDefinitions><ColumnDefinition Width="30"/><ColumnDefinition/></Grid.ColumnDefinitions>
          <TextBlock x:Name="Icon3" Text="○" Foreground="#5A5047" FontSize="15" VerticalAlignment="Center"/>
          <TextBlock x:Name="Text3" Grid.Column="1" Text="Поиск Rust и Blender" Foreground="#8E8478" FontSize="14" VerticalAlignment="Center"/>
        </Grid>
      </StackPanel>

      <ProgressBar x:Name="Bar" Grid.Row="4" Height="8" Minimum="0" Maximum="100" Value="0" Margin="0,6,0,10">
        <ProgressBar.Template>
          <ControlTemplate TargetType="ProgressBar">
            <Grid>
              <Border x:Name="PART_Track" CornerRadius="4" Background="#26221E"/>
              <Border x:Name="PART_Indicator" CornerRadius="4" HorizontalAlignment="Left">
                <Border.Background>
                  <LinearGradientBrush StartPoint="0,0" EndPoint="1,0">
                    <GradientStop Color="#CE422B" Offset="0"/>
                    <GradientStop Color="#E8703F" Offset="1"/>
                  </LinearGradientBrush>
                </Border.Background>
              </Border>
            </Grid>
          </ControlTemplate>
        </ProgressBar.Template>
      </ProgressBar>

      <TextBlock x:Name="Status" Grid.Row="5" Text="Нажми «Установить» — всё остальное сделаю сам." Foreground="#8E8478"
                 FontSize="12" TextWrapping="Wrap" Margin="0,0,0,16" MinHeight="34"/>

      <Button x:Name="Go" Grid.Row="6" Style="{StaticResource Primary}" Content="УСТАНОВИТЬ"/>
    </Grid>
  </Border>
</Window>
'@

# ------------------------------------------------------------------ UI helpers

function Brush([string]$hex) { (New-Object Windows.Media.BrushConverter).ConvertFromString($hex) }
function Dur([int]$ms) { New-Object Windows.Duration ([TimeSpan]::FromMilliseconds($ms)) }

# Let WPF redraw and run animations while we work on the UI thread.
function Pump {
    $frame = New-Object Windows.Threading.DispatcherFrame
    $done = [Action] { $frame.Continue = $false }.GetNewClosure()
    [void][Windows.Threading.Dispatcher]::CurrentDispatcher.BeginInvoke([Windows.Threading.DispatcherPriority]::Background, $done)
    [Windows.Threading.Dispatcher]::PushFrame($frame)
}

function Set-Progress([double]$to) {
    $anim = New-Object Windows.Media.Animation.DoubleAnimation($to, (Dur 400))
    $anim.EasingFunction = New-Object Windows.Media.Animation.CubicEase
    $ui.Bar.BeginAnimation([Windows.Controls.Primitives.RangeBase]::ValueProperty, $anim)
    Pump
}

function Set-Status([string]$text, [string]$color = '#8E8478') {
    $ui.Status.Text = $text
    $ui.Status.Foreground = Brush $color
    Pump
}

function Set-Step([int]$i, [string]$state) {
    $icon = $ui["Icon$i"]; $text = $ui["Text$i"]
    $icon.BeginAnimation([Windows.UIElement]::OpacityProperty, $null)
    switch ($state) {
        'run' {
            $icon.Text = [string][char]0x25CF; $icon.Foreground = Brush '#E8703F'; $text.Foreground = Brush '#ECE4D8'
            $pulse = New-Object Windows.Media.Animation.DoubleAnimation(1, 0.25, (Dur 600))
            $pulse.AutoReverse = $true
            $pulse.RepeatBehavior = [Windows.Media.Animation.RepeatBehavior]::Forever
            $icon.BeginAnimation([Windows.UIElement]::OpacityProperty, $pulse)
        }
        'ok'   { $icon.Text = [string][char]0x2713; $icon.Foreground = Brush '#86A94E'; $text.Foreground = Brush '#ECE4D8' }
        'warn' { $icon.Text = '!'; $icon.Foreground = Brush '#E8703F'; $text.Foreground = Brush '#ECE4D8' }
        'fail' { $icon.Text = [string][char]0x2715; $icon.Foreground = Brush '#CE422B' }
    }
    Pump
}

# ------------------------------------------------------------------ work helpers

function Get-GitHubToken {
    $file = Join-Path $AppDir 'github_token.txt'
    if (Test-Path $file) { (Get-Content $file -Raw).Trim() } else { '' }
}

function Find-Asset([string]$repo, [scriptblock]$score) {
    # All releases, not /latest: FBX2glTF only publishes pre-releases.
    $releases = Invoke-RestMethod "https://api.github.com/repos/$repo/releases?per_page=20" -Headers @{ 'User-Agent' = 'Rust3D' }
    foreach ($r in $releases) {
        $best = $r.assets |
            ForEach-Object { [pscustomobject]@{ Asset = $_; Score = [int](& $score $_.name.ToLower()) } } |
            Where-Object { $_.Score -gt 0 } | Sort-Object Score -Descending | Select-Object -First 1
        if ($best) { return $best.Asset }
    }
    throw "Не нашёл файл для Windows в релизах $repo"
}

function Get-File([string]$url, [string]$dest, [double]$from, [double]$to, [string]$what, [string]$token = '') {
    $req = [Net.HttpWebRequest]::Create($url)
    $req.UserAgent = 'Rust3D'
    if ($token) { $req.Headers['Authorization'] = "token $token" }
    $resp = $req.GetResponse()
    $total = $resp.ContentLength
    $in = $resp.GetResponseStream()
    $out = [IO.File]::Create($dest)
    try {
        $buf = New-Object byte[] 262144
        $done = 0; $tick = 0
        while (($n = $in.Read($buf, 0, $buf.Length)) -gt 0) {
            $out.Write($buf, 0, $n)
            $done += $n
            if ([Environment]::TickCount - $tick -gt 120) {
                $tick = [Environment]::TickCount
                if ($total -gt 0) {
                    Set-Progress ($from + ($to - $from) * $done / $total)
                    Set-Status ('Скачиваю {0}: {1:N1} из {2:N1} МБ' -f $what, ($done / 1MB), ($total / 1MB))
                } else {
                    Set-Status ('Скачиваю {0}: {1:N1} МБ' -f $what, ($done / 1MB))
                }
            }
        }
    } finally {
        $out.Dispose(); $in.Dispose(); $resp.Dispose()
    }
}

# Pulls the latest version of this repository and copies it over the program folder.
function Update-Program {
    $tmp = Join-Path $env:TEMP ('rust3d-update-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Force $tmp | Out-Null
    try {
        $zip = Join-Path $tmp 'rust3d.zip'
        try {
            Get-File "https://api.github.com/repos/$Repo/zipball" $zip 2 10 'обновление' (Get-GitHubToken)
        } catch [Net.WebException] {
            $code = [int]$_.Exception.Response.StatusCode
            if ($code -eq 404 -or $code -eq 401) {
                throw "GitHub не отдаёт файлы: репозиторий $Repo закрытый. Сделай его публичным (Settings → General → Change visibility) или положи токен GitHub в %APPDATA%\Rust3D\github_token.txt"
            }
            throw
        }
        Set-Status 'Распаковываю обновление…'
        $src = Join-Path $tmp 'src'
        [IO.Compression.ZipFile]::ExtractToDirectory($zip, $src)
        $top = Get-ChildItem $src -Directory | Select-Object -First 1
        if (-not $top -or -not (Test-Path (Join-Path $top.FullName 'extension'))) { throw 'В обновлении нет папки extension' }
        Copy-Item (Join-Path $top.FullName '*') $Root -Recurse -Force
    } finally {
        Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Read-Config {
    $cfg = [ordered]@{ rustDir = ''; blender = ''; assetStudio = ''; fbx2gltf = ''; exportDir = ''; installDir = '' }
    $file = Join-Path $AppDir 'config.json'
    if (Test-Path $file) {
        try {
            $old = Get-Content $file -Raw -Encoding UTF8 | ConvertFrom-Json
            foreach ($p in $old.PSObject.Properties) { $cfg[$p.Name] = $p.Value }
        } catch { }
    }
    $cfg
}

function Save-Config($cfg) {
    New-Item -ItemType Directory -Force $AppDir | Out-Null
    # The panel reads it with Node: UTF-8 without BOM.
    [IO.File]::WriteAllText((Join-Path $AppDir 'config.json'), ($cfg | ConvertTo-Json), (New-Object Text.UTF8Encoding $false))
}

function Find-Rust {
    $roots = @()
    foreach ($k in 'HKCU:\Software\Valve\Steam', 'HKLM:\SOFTWARE\WOW6432Node\Valve\Steam') {
        $item = Get-ItemProperty $k -ErrorAction SilentlyContinue
        if ($item) { $roots += $item.SteamPath, $item.InstallPath }
    }
    $roots += "${env:ProgramFiles(x86)}\Steam"
    $libs = @()
    foreach ($r in ($roots | Where-Object { $_ } | Select-Object -Unique)) {
        $libs += $r
        $vdf = Join-Path $r 'steamapps\libraryfolders.vdf'
        if (Test-Path $vdf) {
            $libs += [regex]::Matches((Get-Content $vdf -Raw), '"path"\s+"([^"]+)"') | ForEach-Object { $_.Groups[1].Value -replace '\\\\', '\' }
        }
    }
    foreach ($l in $libs) {
        $p = Join-Path $l 'steamapps\common\Rust'
        if (Test-Path (Join-Path $p 'Bundles')) { return (Resolve-Path $p).Path }
    }
    ''
}

function Find-Blender {
    $hit = Get-ChildItem "$env:ProgramFiles\Blender Foundation\Blender*\blender.exe" -ErrorAction SilentlyContinue |
        Sort-Object { try { [version](($_.Directory.Name -replace '[^\d.]', '') + '.0') } catch { [version]'0.0' } } |
        Select-Object -Last 1
    if ($hit) { return $hit.FullName }
    $cmd = Get-Command blender -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    ''
}

# ------------------------------------------------------------------ install

function Install {
    $ui.Go.IsEnabled = $false
    $ui.CloseBtn.IsEnabled = $false
    $step = 0
    try {
        # 0. (update mode) Latest files from GitHub.
        if ($Update) {
            $step = 4; Set-Step 4 'run'; Set-Status 'Скачиваю свежую версию…'; Set-Progress 2
            Update-Program
            Set-Step 4 'ok'; Set-Progress 12
        }

        # 1. Panel into the CEP extensions folder + allow unsigned panels.
        $step = 0; Set-Step 0 'run'; Set-Status 'Ставлю панель…'; Set-Progress 14
        New-Item -ItemType Directory -Force $CepDir | Out-Null
        foreach ($old in 'com.rust3d.importer', $PanelId) {
            $p = Join-Path $CepDir $old
            if (Test-Path $p) { Remove-Item $p -Recurse -Force }
        }
        $dst = Join-Path $CepDir $PanelId
        Copy-Item (Join-Path $Root 'extension') $dst -Recurse
        Get-ChildItem $dst -Recurse -File | Unblock-File
        foreach ($v in 9..14) {
            $k = "HKCU:\Software\Adobe\CSXS.$v"
            if (-not (Test-Path $k)) { New-Item $k -Force | Out-Null }
            Set-ItemProperty $k -Name PlayerDebugMode -Value '1'
        }
        Set-Step 0 'ok'; Set-Progress 18

        # 2. AssetStudioModCLI (skipped if already downloaded).
        $step = 1; Set-Step 1 'run'
        $cfg = Read-Config
        $cfg.installDir = $Root
        $asDir = Join-Path $Tools 'AssetStudioModCLI'
        $asExe = Get-ChildItem $asDir -Recurse -Filter AssetStudioModCLI.exe -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $asExe) {
            Set-Status 'Ищу последнюю версию AssetStudio…'
            $a = Find-Asset 'aelurum/AssetStudio' {
                param($n)
                if ($n -notlike '*assetstudiomodcli*' -or $n -notlike '*.zip' -or $n -like '*linux*' -or $n -like '*mac*') { 0 }
                else { 1 + 2 * [int]($n -like '*net472*') + [int]($n -like '*win*') }
            }
            New-Item -ItemType Directory -Force $Tools | Out-Null
            $zip = Join-Path $Tools $a.name
            Get-File $a.browser_download_url $zip 18 58 'AssetStudio'
            Set-Status 'Распаковываю AssetStudio…'
            if (Test-Path $asDir) { Remove-Item $asDir -Recurse -Force }
            [IO.Compression.ZipFile]::ExtractToDirectory($zip, $asDir)
            Remove-Item $zip
            $asExe = Get-ChildItem $asDir -Recurse -Filter AssetStudioModCLI.exe | Select-Object -First 1
            if (-not $asExe) { throw 'В архиве AssetStudio нет AssetStudioModCLI.exe' }
        }
        $cfg.assetStudio = $asExe.FullName
        Set-Step 1 'ok'; Set-Progress 60

        # 3. FBX2glTF.
        $step = 2; Set-Step 2 'run'
        $fbx = Join-Path $Tools 'FBX2glTF.exe'
        if (-not (Test-Path $fbx)) {
            Set-Status 'Ищу конвертер FBX2glTF…'
            $a = Find-Asset 'facebookincubator/FBX2glTF' { param($n) if ($n -like '*windows*' -and $n -like '*.exe') { 1 } else { 0 } }
            New-Item -ItemType Directory -Force $Tools | Out-Null
            Get-File $a.browser_download_url $fbx 60 90 'FBX2glTF'
        }
        $cfg.fbx2gltf = $fbx
        Set-Step 2 'ok'; Set-Progress 92

        # 4. Rust + Blender.
        $step = 3; Set-Step 3 'run'; Set-Status 'Ищу Rust и Blender…'
        if (-not ($cfg.rustDir -and (Test-Path $cfg.rustDir))) { $cfg.rustDir = Find-Rust }
        if (-not ($cfg.blender -and (Test-Path $cfg.blender))) { $cfg.blender = Find-Blender }
        if (-not $cfg.exportDir) { $cfg.exportDir = Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'Rust3D' }
        Save-Config $cfg
        $notes = @()
        if (-not $cfg.rustDir) { $notes += 'Rust не найден — укажешь папку в настройках панели.' }
        if (-not $cfg.blender) { $notes += 'Blender не найден — он нужен только для Premiere (blender.org).' }
        Set-Step 3 $(if ($notes) { 'warn' } else { 'ok' })
        Set-Progress 100

        $running = Get-Process AfterFX, 'Adobe Premiere Pro' -ErrorAction SilentlyContinue
        $msg = if ($running) { 'Готово! Закрой и снова открой панель Rust3D (Окно → Расширения → Rust3D).' }
               else { 'Готово! Открой After Effects или Premiere Pro → Окно → Расширения → Rust3D.' }
        if ($notes) { $msg += "`n" + ($notes -join "`n") }
        Set-Status $msg '#ECE4D8'
        $ui.Go.Content = 'ЗАКРЫТЬ'
        $script:finished = $true
    } catch {
        Set-Step $step 'fail'
        Set-Status ('Ошибка: ' + $_.Exception.Message) '#E8703F'
        $ui.Go.Content = 'ПОВТОРИТЬ'
    } finally {
        $ui.Go.IsEnabled = $true
        $ui.CloseBtn.IsEnabled = $true
    }
}

# ------------------------------------------------------------------ window

try {
    $win = [Windows.Markup.XamlReader]::Load((New-Object System.Xml.XmlNodeReader $xaml))
    $ui = @{}
    foreach ($n in 'Card', 'CloseBtn', 'Bar', 'Status', 'Go', 'Subtitle', 'UpdRow',
                   'Icon0', 'Icon1', 'Icon2', 'Icon3', 'Icon4', 'Text0', 'Text1', 'Text2', 'Text3', 'Text4') {
        $ui[$n] = $win.FindName($n)
    }
    if ($Update) {
        $ui.UpdRow.Visibility = 'Visible'
        $ui.Subtitle.Text = 'Обновление Rust3D'
        $ui.Go.Content = 'ОБНОВИТЬ'
        $ui.Status.Text = 'Скачаю свежую версию с GitHub и переустановлю панель.'
    }

    $win.Add_MouseLeftButtonDown({ try { $win.DragMove() } catch { } })
    $ui.CloseBtn.Add_Click({ $win.Close() })
    $ui.Go.Add_Click({ if ($script:finished) { $win.Close() } else { Install } })
    $win.Add_Loaded({
        $fade = New-Object Windows.Media.Animation.DoubleAnimation(0, 1, (Dur 450))
        $ui.Card.BeginAnimation([Windows.UIElement]::OpacityProperty, $fade)
        $zoom = New-Object Windows.Media.Animation.DoubleAnimation(0.96, 1, (Dur 450))
        $zoom.EasingFunction = New-Object Windows.Media.Animation.CubicEase
        $ui.Card.RenderTransform.BeginAnimation([Windows.Media.ScaleTransform]::ScaleXProperty, $zoom)
        $ui.Card.RenderTransform.BeginAnimation([Windows.Media.ScaleTransform]::ScaleYProperty, $zoom)
    })
    # Updates start on their own once the window is visible.
    if ($Update) { $win.Add_ContentRendered({ Install }) }
    [void]$win.ShowDialog()
} catch {
    [Windows.MessageBox]::Show("Не удалось запустить установщик:`n`n$($_.Exception.Message)", 'Rust3D') | Out-Null
}
