import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const EDGES = [
    ['right', 'Direita'],
    ['left', 'Esquerda'],
    ['top', 'Em cima'],
    ['bottom', 'Embaixo'],
];

// An Adw row carrying a horizontal slider bound to a double key.
function sliderRow(settings, key, {title, subtitle, min, max, step, format}) {
    const row = new Adw.ActionRow({title, subtitle});
    const scale = new Gtk.Scale({
        orientation: Gtk.Orientation.HORIZONTAL,
        adjustment: new Gtk.Adjustment({lower: min, upper: max, step_increment: step, page_increment: step * 10}),
        draw_value: true,
        value_pos: Gtk.PositionType.RIGHT,
        hexpand: true,
        width_request: 220,
        valign: Gtk.Align.CENTER,
    });
    scale.set_format_value_func((_s, value) => format(value));
    settings.bind(key, scale.adjustment, 'value', Gio.SettingsBindFlags.DEFAULT);
    row.add_suffix(scale);
    row.activatable_widget = scale;
    return row;
}

function toHex(rgba) {
    const c = v => Math.round(v * 255).toString(16).padStart(2, '0');
    return `#${c(rgba.red)}${c(rgba.green)}${c(rgba.blue)}`;
}

function colorRow(settings, key, {title, subtitle}) {
    const row = new Adw.ActionRow({title, subtitle});
    const rgba = new Gdk.RGBA();
    rgba.parse(settings.get_string(key));
    const button = new Gtk.ColorDialogButton({
        dialog: new Gtk.ColorDialog({with_alpha: false, title}),
        rgba,
        valign: Gtk.Align.CENTER,
    });
    button.connect('notify::rgba', () => {
        const hex = toHex(button.rgba);
        if (settings.get_string(key) !== hex)
            settings.set_string(key, hex);
    });
    settings.connect(`changed::${key}`, () => {
        const fresh = new Gdk.RGBA();
        if (fresh.parse(settings.get_string(key)) && toHex(fresh) !== toHex(button.rgba))
            button.rgba = fresh;
    });
    row.add_suffix(button);
    row.activatable_widget = button;
    return row;
}

export default class CodenotchPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.search_enabled = true;

        const page = new Adw.PreferencesPage({
            title: 'Codenotch',
            icon_name: 'preferences-desktop-appearance-symbolic',
        });
        window.add(page);

        // Where it lives
        const position = new Adw.PreferencesGroup({
            title: 'Posição',
            description: 'Em qual borda da tela o notch fica soldado, e onde ao longo dela.',
        });
        page.add(position);

        const edgeRow = new Adw.ComboRow({
            title: 'Borda',
            subtitle: 'O notch se abre para dentro da tela a partir desta borda',
            model: Gtk.StringList.new(EDGES.map(([, label]) => label)),
        });
        const syncEdge = () => {
            const index = Math.max(0, EDGES.findIndex(([nick]) => nick === settings.get_string('edge')));
            if (edgeRow.selected !== index)
                edgeRow.selected = index;
        };
        syncEdge();
        edgeRow.connect('notify::selected', () => settings.set_string('edge', EDGES[edgeRow.selected][0]));
        settings.connect('changed::edge', syncEdge);
        position.add(edgeRow);

        position.add(sliderRow(settings, 'position', {
            title: 'Posição ao longo da borda',
            subtitle: 'Nas laterais, mais para cima ou para baixo; em cima e embaixo, mais para a esquerda ou direita',
            min: 0, max: 1, step: 0.01,
            format: v => `${Math.round(v * 100)}%`,
        }));

        // How it looks
        const look = new Adw.PreferencesGroup({
            title: 'Aparência',
            description: 'Anéis, texto e logotipos não mudam; só o corpo preto.',
        });
        page.add(look);

        look.add(colorRow(settings, 'color', {
            title: 'Cor do corpo',
            subtitle: 'O original é preto puro, para parecer parte do bisel',
        }));

        look.add(sliderRow(settings, 'opacity', {
            title: 'Opacidade do corpo',
            subtitle: 'Abaixo de 100% o fundo aparece através do notch e do cartão',
            min: 0.1, max: 1, step: 0.05,
            format: v => `${Math.round(v * 100)}%`,
        }));

        look.add(sliderRow(settings, 'scale', {
            title: 'Tamanho',
            subtitle: 'Escala tudo junto, do anel ao cartão',
            min: 0.6, max: 2, step: 0.05,
            format: v => `${Math.round(v * 100)}%`,
        }));

        const labels = new Adw.SwitchRow({
            title: 'Mostrar porcentagem',
            subtitle: 'O número embaixo de cada anel',
        });
        settings.bind('show-labels', labels, 'active', Gio.SettingsBindFlags.DEFAULT);
        look.add(labels);

        // How it behaves
        const behaviour = new Adw.PreferencesGroup({title: 'Comportamento'});
        page.add(behaviour);

        const alwaysOpen = new Adw.SwitchRow({
            title: 'Sempre aberto',
            subtitle: 'Fica desdobrado o tempo todo em vez de recolher numa pílula',
        });
        settings.bind('always-open', alwaysOpen, 'active', Gio.SettingsBindFlags.DEFAULT);
        behaviour.add(alwaysOpen);

        const fullscreen = new Adw.SwitchRow({
            title: 'Esconder em tela cheia',
            subtitle: 'Some enquanto uma janela em tela cheia está no mesmo monitor',
        });
        settings.bind('hide-in-fullscreen', fullscreen, 'active', Gio.SettingsBindFlags.DEFAULT);
        behaviour.add(fullscreen);

        const refresh = new Adw.SpinRow({
            title: 'Intervalo de leitura',
            subtitle: 'Segundos entre consultas de uso a cada ferramenta',
            adjustment: new Gtk.Adjustment({lower: 15, upper: 900, step_increment: 15, page_increment: 60}),
        });
        settings.bind('refresh-interval', refresh, 'value', Gio.SettingsBindFlags.DEFAULT);
        behaviour.add(refresh);
    }
}
