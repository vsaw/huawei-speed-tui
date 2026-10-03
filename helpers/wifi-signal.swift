// Streams this Mac's Wi-Fi link quality as one JSON object per line.
// Usage: wifi-signal [intervalMs]
// Compiled on demand by src/wifi.ts; exits when its parent process goes away.

import CoreWLAN
import Foundation

setvbuf(stdout, nil, _IOLBF, 0)
let intervalMs = CommandLine.arguments.count > 1 ? Int(CommandLine.arguments[1]) ?? 1000 : 1000
let parent = getppid()

func phyName(_ mode: CWPHYMode) -> String {
    switch mode {
    case .mode11a: return "802.11a"
    case .mode11b: return "802.11b"
    case .mode11g: return "802.11g"
    case .mode11n: return "802.11n (Wi-Fi 4)"
    case .mode11ac: return "802.11ac (Wi-Fi 5)"
    case .mode11ax: return "802.11ax (Wi-Fi 6)"
    default: return ""
    }
}

func bandName(_ band: CWChannelBand) -> String {
    switch band {
    case .band2GHz: return "2.4 GHz"
    case .band5GHz: return "5 GHz"
    case .band6GHz: return "6 GHz"
    default: return ""
    }
}

func widthName(_ width: CWChannelWidth) -> String {
    switch width {
    case .width20MHz: return "20 MHz"
    case .width40MHz: return "40 MHz"
    case .width80MHz: return "80 MHz"
    case .width160MHz: return "160 MHz"
    default: return ""
    }
}

while getppid() == parent {
    var out: [String: Any] = ["powerOn": false]
    if let wifi = CWWiFiClient.shared().interface() {
        out["interface"] = wifi.interfaceName ?? ""
        out["powerOn"] = wifi.powerOn()
        // wlanChannel is nil while not associated with a network.
        if let channel = wifi.wlanChannel(), wifi.rssiValue() != 0 {
            out["rssi"] = wifi.rssiValue()
            out["noise"] = wifi.noiseMeasurement()
            out["txRate"] = wifi.transmitRate()
            out["channel"] = channel.channelNumber
            out["band"] = bandName(channel.channelBand)
            out["width"] = widthName(channel.channelWidth)
            out["phy"] = phyName(wifi.activePHYMode())
        }
    }
    if let data = try? JSONSerialization.data(withJSONObject: out), let line = String(data: data, encoding: .utf8) {
        print(line)
    }
    usleep(useconds_t(intervalMs * 1000))
}
