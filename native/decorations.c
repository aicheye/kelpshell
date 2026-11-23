// Server-side window decorations for chosen Wayland clients.
//
// A Wayland client asks the compositor for a title bar with the
// xdg-decoration protocol. Mutter does not have that protocol, so a client
// that wants a title bar and has none of its own draws a fallback. Chromium's
// fallback is a blue title bar and border inside the window, and programs
// built on it place their own controls as if that frame were not there:
// Spotify draws its menu button 26 px too high.
//
// This module adds the protocol to the running shell. A client that matches
// a rule is told that the compositor draws its decorations. It then draws no
// frame, and the extension draws the title bar (lib/titlebar.js). Every other
// client is not shown the protocol at all, so nothing changes for it.
//
// The shell loads the module as a GIO module (lib/decorations.js). The two
// sides share two files in $XDG_RUNTIME_DIR/kelpshell:
//
//   decorate    written by the extension: one rule per line, lower case. A
//               client matches when a rule is part of its process name.
//   decorated   written here: the process id of every client that has a
//               window with server-side decorations, one per line.
//
// libwayland-server and Mutter are declared below and not included: their
// headers are not needed to build this, only the libraries of the running
// shell. The Mutter functions are not in its public headers, so the module
// is built for one version of the shell (dev/build-native.sh).

#include <gio/gio.h>
#include <stdint.h>
#include <string.h>
#include <sys/types.h>

// ---------------------------------------------------------------- libwayland

struct wl_display;
struct wl_client;
struct wl_resource;
struct wl_global;
struct wl_interface;

struct wl_message {
    const char *name;
    const char *signature;
    const struct wl_interface **types;
};

struct wl_interface {
    const char *name;
    int version;
    int method_count;
    const struct wl_message *methods;
    int event_count;
    const struct wl_message *events;
};

struct wl_list {
    struct wl_list *prev;
    struct wl_list *next;
};

struct wl_listener {
    struct wl_list link;
    void (*notify) (struct wl_listener *listener, void *data);
};

typedef void (*wl_global_bind_func_t) (struct wl_client *client, void *data,
                                       uint32_t version, uint32_t id);
typedef void (*wl_resource_destroy_func_t) (struct wl_resource *resource);

extern struct wl_global *wl_global_create (struct wl_display *display,
                                           const struct wl_interface *interface,
                                           int version, void *data,
                                           wl_global_bind_func_t bind);
extern struct wl_resource *wl_resource_create (struct wl_client *client,
                                               const struct wl_interface *interface,
                                               int version, uint32_t id);
extern void wl_resource_set_implementation (struct wl_resource *resource,
                                            const void *implementation, void *data,
                                            wl_resource_destroy_func_t destroy);
extern void *wl_resource_get_user_data (struct wl_resource *resource);
extern struct wl_client *wl_resource_get_client (struct wl_resource *resource);
extern void wl_resource_post_event (struct wl_resource *resource, uint32_t opcode, ...);
extern void wl_resource_destroy (struct wl_resource *resource);
extern void wl_client_post_no_memory (struct wl_client *client);
extern void wl_client_get_credentials (struct wl_client *client,
                                       pid_t *pid, uid_t *uid, gid_t *gid);
extern void wl_client_add_destroy_listener (struct wl_client *client,
                                            struct wl_listener *listener);
extern void wl_display_add_client_created_listener (struct wl_display *display,
                                                    struct wl_listener *listener);

// -------------------------------------------------------------------- Mutter

// MetaWaylandAccess, the answer of a filter: 0 allowed, 1 denied.
#define ACCESS_ALLOWED 0
#define ACCESS_DENIED 1

typedef int (*MetaWaylandFilterFunc) (const struct wl_client *client,
                                      const struct wl_global *global,
                                      gpointer user_data);

extern gpointer shell_global_get (void);
extern gpointer shell_global_get_context (gpointer global);
extern gpointer meta_context_get_wayland_compositor (gpointer context);
extern struct wl_display *meta_wayland_compositor_get_wayland_display (gpointer compositor);
extern gpointer meta_wayland_compositor_get_filter_manager (gpointer compositor);
extern void meta_wayland_filter_manager_add_global (gpointer filter_manager,
                                                    struct wl_global *global,
                                                    MetaWaylandFilterFunc filter,
                                                    gpointer user_data);

// ------------------------------------------- xdg-decoration-unstable-v1

#define MODE_CLIENT_SIDE 1
#define MODE_SERVER_SIDE 2
#define EVENT_CONFIGURE 0

static const struct wl_interface decoration_interface;

static const struct wl_interface *no_types[] = { NULL };
// The second argument is the xdg_toplevel. Its interface is inside Mutter,
// so the type is left open.
static const struct wl_interface *get_types[] = { &decoration_interface, NULL };

static const struct wl_message manager_requests[] = {
    { "destroy", "", no_types },
    { "get_toplevel_decoration", "no", get_types },
};

static const struct wl_interface manager_interface = {
    "zxdg_decoration_manager_v1", 1, 2, manager_requests, 0, NULL,
};

static const struct wl_message decoration_requests[] = {
    { "destroy", "", no_types },
    { "set_mode", "u", no_types },
    { "unset_mode", "", no_types },
};

static const struct wl_message decoration_events[] = {
    { "configure", "u", no_types },
};

static const struct wl_interface decoration_interface = {
    "zxdg_toplevel_decoration_v1", 1, 3, decoration_requests, 1, decoration_events,
};

// ------------------------------------------------------------------- clients

typedef struct {
    struct wl_listener destroyed;   // first: the listener is cast back to the client
    struct wl_client *client;
    pid_t pid;
    gboolean old;       // connected before the protocol was added
    gboolean decided;
    gboolean match;     // a rule names this client
    int served;         // its windows with server-side decorations
} Client;

static GHashTable *clients;         // wl_client -> Client
static struct wl_listener client_created;

static char *
runtime_file (const char *name)
{
    return g_build_filename (g_get_user_runtime_dir (), "kelpshell", name, NULL);
}

/** The pids of the clients with a decorated window, for the extension. */
static void
write_served (void)
{
    g_autoptr (GString) text = g_string_new (NULL);
    g_autofree char *path = runtime_file ("decorated");
    g_autofree char *dir = g_path_get_dirname (path);
    GHashTableIter iter;
    gpointer value;

    g_hash_table_iter_init (&iter, clients);
    while (g_hash_table_iter_next (&iter, NULL, &value)) {
        Client *c = value;
        if (c->served > 0)
            g_string_append_printf (text, "%d\n", (int) c->pid);
    }
    g_mkdir_with_parents (dir, 0700);
    g_file_set_contents (path, text->str, text->len, NULL);
}

/** Whether a rule of the extension is part of the name of this process. */
static gboolean
process_matches (pid_t pid)
{
    g_autofree char *rules_path = runtime_file ("decorate");
    g_autofree char *rules = NULL;
    g_autofree char *comm_path = g_strdup_printf ("/proc/%d/comm", (int) pid);
    g_autofree char *cmdline_path = g_strdup_printf ("/proc/%d/cmdline", (int) pid);
    g_autofree char *comm = NULL;
    g_autofree char *cmdline = NULL;
    g_autofree char *program = NULL;
    g_auto (GStrv) lines = NULL;
    gboolean match = FALSE;

    if (pid <= 0 || !g_file_get_contents (rules_path, &rules, NULL, NULL))
        return FALSE;
    // comm is the name of the executable, cut at 15 characters. The first
    // argument has the whole name.
    if (g_file_get_contents (comm_path, &comm, NULL, NULL)) {
        char *lower = g_ascii_strdown (g_strstrip (comm), -1);
        g_free (comm);
        comm = lower;
    }
    if (g_file_get_contents (cmdline_path, &cmdline, NULL, NULL) && *cmdline) {
        g_autofree char *base = g_path_get_basename (cmdline);
        program = g_ascii_strdown (base, -1);
    }
    lines = g_strsplit (rules, "\n", -1);
    for (char **line = lines; *line && !match; line++) {
        const char *rule = g_strstrip (*line);
        if (!*rule)
            continue;
        match = (comm && strstr (comm, rule)) || (program && strstr (program, rule));
    }
    return match;
}

static void
on_client_destroyed (struct wl_listener *listener, void *data)
{
    Client *c = (Client *) listener;
    gboolean served = c->served > 0;

    g_hash_table_remove (clients, c->client);   // frees c
    if (served)
        write_served ();
}

static Client *
add_client (struct wl_client *client, gboolean old)
{
    Client *c = g_new0 (Client, 1);
    uid_t uid;
    gid_t gid;

    c->client = client;
    c->old = old;
    wl_client_get_credentials (client, &c->pid, &uid, &gid);
    c->destroyed.notify = on_client_destroyed;
    wl_client_add_destroy_listener (client, &c->destroyed);
    g_hash_table_insert (clients, client, c);
    return c;
}

static void
on_client_created (struct wl_listener *listener, void *data)
{
    add_client (data, FALSE);
}

static Client *
get_client (struct wl_client *client)
{
    Client *c = g_hash_table_lookup (clients, client);

    // Not seen at its creation: it was there before this module.
    if (!c)
        c = add_client (client, TRUE);
    if (!c->decided) {
        c->match = process_matches (c->pid);
        c->decided = TRUE;
    }
    return c;
}

/**
 * Who is shown the protocol. A client that was connected before the
 * protocol existed has been told about it already, so it may bind it: a
 * refused bind is a protocol error that ends the client. Such a client gets
 * client-side decorations unless a rule names it.
 */
static int
filter (const struct wl_client *client, const struct wl_global *global, gpointer user_data)
{
    Client *c = get_client ((struct wl_client *) client);

    return c->old || c->match ? ACCESS_ALLOWED : ACCESS_DENIED;
}

// --------------------------------------------------------------- decorations

// The data of a decoration object: whether it is server-side now.
static void
set_served (struct wl_resource *resource, gboolean served)
{
    gboolean *state = wl_resource_get_user_data (resource);
    Client *c = g_hash_table_lookup (clients, wl_resource_get_client (resource));

    if (*state == served)
        return;
    *state = served;
    // A client that is being destroyed is out of the table already.
    if (!c)
        return;
    c->served += served ? 1 : -1;
    if (c->served == (served ? 1 : 0))
        write_served ();
}

static void
configure (struct wl_resource *resource, gboolean server_side)
{
    Client *c = get_client (wl_resource_get_client (resource));
    gboolean served = server_side && c->match;

    set_served (resource, served);
    wl_resource_post_event (resource, EVENT_CONFIGURE,
                            (uint32_t) (served ? MODE_SERVER_SIDE : MODE_CLIENT_SIDE));
}

static void
resource_destroy (struct wl_client *client, struct wl_resource *resource)
{
    wl_resource_destroy (resource);
}

static void
decoration_set_mode (struct wl_client *client, struct wl_resource *resource, uint32_t mode)
{
    configure (resource, mode != MODE_CLIENT_SIDE);
}

static void
decoration_unset_mode (struct wl_client *client, struct wl_resource *resource)
{
    configure (resource, TRUE);
}

static void
decoration_destroyed (struct wl_resource *resource)
{
    set_served (resource, FALSE);
    g_free (wl_resource_get_user_data (resource));
}

static const struct {
    void (*destroy) (struct wl_client *, struct wl_resource *);
    void (*set_mode) (struct wl_client *, struct wl_resource *, uint32_t);
    void (*unset_mode) (struct wl_client *, struct wl_resource *);
} decoration_implementation = {
    resource_destroy,
    decoration_set_mode,
    decoration_unset_mode,
};

static void
manager_get_toplevel_decoration (struct wl_client *client, struct wl_resource *manager,
                                 uint32_t id, struct wl_resource *toplevel)
{
    struct wl_resource *resource = wl_resource_create (client, &decoration_interface, 1, id);

    if (!resource) {
        wl_client_post_no_memory (client);
        return;
    }
    wl_resource_set_implementation (resource, &decoration_implementation,
                                    g_new0 (gboolean, 1), decoration_destroyed);
    // The mode the compositor prefers, before the client has asked for one.
    configure (resource, TRUE);
}

static const struct {
    void (*destroy) (struct wl_client *, struct wl_resource *);
    void (*get_toplevel_decoration) (struct wl_client *, struct wl_resource *,
                                     uint32_t, struct wl_resource *);
} manager_implementation = {
    resource_destroy,
    manager_get_toplevel_decoration,
};

static void
manager_bind (struct wl_client *client, void *data, uint32_t version, uint32_t id)
{
    struct wl_resource *resource = wl_resource_create (client, &manager_interface, 1, id);

    if (!resource) {
        wl_client_post_no_memory (client);
        return;
    }
    wl_resource_set_implementation (resource, &manager_implementation, NULL, NULL);
}

// -------------------------------------------------------------------- module

void
g_io_module_load (GIOModule *module)
{
    static gboolean loaded;
    gpointer compositor;
    struct wl_display *display;
    struct wl_global *global;

    if (loaded)
        return;
    loaded = TRUE;
    // Clients hold objects whose requests are handled by this code, so it
    // stays in memory for the life of the shell.
    g_type_module_use (G_TYPE_MODULE (module));

    compositor = meta_context_get_wayland_compositor (shell_global_get_context (shell_global_get ()));
    if (!compositor)
        return;
    display = meta_wayland_compositor_get_wayland_display (compositor);

    clients = g_hash_table_new_full (NULL, NULL, NULL, g_free);
    client_created.notify = on_client_created;
    wl_display_add_client_created_listener (display, &client_created);

    global = wl_global_create (display, &manager_interface, 1, NULL, manager_bind);
    if (!global)
        return;
    meta_wayland_filter_manager_add_global (meta_wayland_compositor_get_filter_manager (compositor),
                                            global, filter, NULL);
    // The file is there, empty: the extension reads from it that the
    // protocol is on.
    write_served ();
}

void
g_io_module_unload (GIOModule *module)
{
}
