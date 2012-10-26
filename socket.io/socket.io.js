(function(){

    // =====================================================================
    // PubNub Socket.IO
    // =====================================================================
    var p          = PUBNUB
    ,   uuid       = PUBNUB.db.get('uuid') || p.uuid(function(id){
            PUBNUB.db.set( 'uuid', uuid = id )
        })
    ,   now        = function(){return+new Date}
    ,   namespaces = {}
    ,   users      = {}
    ,   io         = window.io = {
        connected : {},
        connect   : function( host, setup ) {

            // PARSE SETUP and HOST
            var urlbits   = (host+'////').split('/')
            ,   setup     = setup || {}
            ,   cuser     = setup['user'] || {}
            ,   presence  = 'presence' in setup ? setup['presence'] : true
            ,   origin    = urlbits[2]
            ,   namespace = (urlbits[3] || 'standard') + '-' + setup.channel
            ,   channel   = setup.channel
            ,   socket    = get_socket(namespace);

            // PASSWORD ENCRYPTION
            socket.password = 'sjcl' in window && setup.password;

            // PUBNUB ALREADY CONNECTED?
            if (channel in io.connected) {
                socket.p = io.connected[channel];
                return socket;
            }

            // GEO LOCATION
            if (setup.geo) setInterval( locate, 15000 ) && locate();

            // SETUP PUBNUB
            setup.origin = origin;
            var p                     =
                socket.p              =
                io.connected[channel] =
                PUBNUB.init(setup);

            p.disconnected = 0;
            p.channel      = socket.channel = setup.channel;

            // DISCONNECTED
            function dropped() {
                if (p.disconnected) return;
                p.disconnected = 1;
                p.each( namespaces, function(ns) {
                    p.events.fire( ns + 'disconnect', {} ) 
                } );
            }

            // ESTABLISH CONNECTION
            p.subscribe({
                channel : p.channel,
                disconnect : dropped,
                reconnect : function() {p.disconnected = 0;},
                connect : function() {
                    p.disconnected = 0;
                    p.each( namespaces, function(ns) {
                        if (get_socket(ns).connected) return;
                        get_socket(ns).connected = true;
                        p.events.fire( ns + 'connect', {} );
                    } );
                },
                callback : function(evt) {
                    if (p.disconnected) p.each( namespaces, function(ns) {
                        p.events.fire( ns + 'reconnect', {} ) 
                    } );
 
                    p.disconnected = 0;

                    var data = decrypt( evt.ns, evt.data );

                    if (evt.ns in namespaces)
                        data && p.events.fire( evt.ns + evt.name, data );

                    // USER EVENTS
                    if (!evt.uuid || evt.uuid === uuid) return;

                    evt.name === 'ping' && p.each( data.nss, function(ns) {

                        users[ns] = users[ns] || {};

                        var user = users[ns][evt.uuid] =
                        users[ns][evt.uuid] || (function() { return {
                            geo       : evt.geo || [ 0, 0 ],
                            uuid      : evt.uuid,
                            last      : now(),
                            socket    : socket,
                            namespace : ns,
                            connected : false,
                            slot      : socket.user_count++
                        } })();

                        user.last = now();
                        user.data = data.cuser;

                        if (user.connected) return;

                        user.connected = true;
                        p.events.fire( ns + 'join', user );

                    } );

                    if (evt.name === 'user-disconnect') disconnect(evt.uuid);
                }
            });

            // TCP KEEP ALIVE
            if (presence)
                p.tcpKeepAlive = setInterval( p.updater( function() {
                    var nss = p.map( namespaces, function(ns) { return ns } );
                    send( 'ping', namespace, { nss : nss, cuser : cuser } );
                }, 3000 ), 500 );

            // RETURN SOCKET
            return socket;
        }
    };

    // =====================================================================
    // Advanced User Presence
    // =====================================================================
    setInterval( function() {
        p.each( users, function(namespace) {
            p.each( users[namespace], function(uid) {
                var user = users[namespace][uid];
                if (now() - user.last < 5500 || uid === uuid) return;
                disconnect(user.uuid);
            } );
        } );
    }, 1000 );

    function disconnect(uid) {
        p.each( namespaces, function(ns) {
            var user = users[ns][uid];
            if (!user.connected) return;

            user.connected = false;
            user.socket.user_count--;
            p.events.fire( ns + 'leave', user ) 
        } );
    }

    typeof window !== 'undefined' &&
    p.bind( 'beforeunload', window, function() {
        send( 'user-disconnect', '', uuid );
        return true;
    } );

    // =====================================================================
    // Stanford Crypto Library with AES Encryption
    // =====================================================================
    function encrypt( namespace, data ) {
        var namespace = namespace
        ,   socket    = get_socket(namespace);

        return 'password' in socket && socket.password && sjcl.encrypt(
           socket.password, JSON.stringify(data)+''
        ) || data;
    }

    function decrypt( namespace, data ) {
        var namespace = namespace
        ,   socket    = get_socket(namespace);

        if (!socket.password) return data;
        try { return JSON.parse(
            sjcl.decrypt( socket.password, data )
        ); }
        catch(e) { return null; }
    }

    // =====================================================================
    // PUBLISH A MESSAGE + Retry if Failed with fallback
    // =====================================================================
    function send( event, namespace, data, wait, cb ) {
        var p = get_socket(namespace).p;
        p.publish({
            channel : p.channel,
            message : {
                name : event,
                ns   : namespace,
                data : encrypt( namespace, data || {} ),
                uuid : uuid,
                geo  : p.location || [ 0, 0 ]
            },
            callback : function(info) {
                if (info[0]) return (cb||function(){})(info);
                var retry = (wait || 500) * 2;
                setTimeout( function() {
                    send( event, namespace, data, retry, cb );
                }, retry > 5500 ? 5500 : retry );
            }
        });
    }

    // =====================================================================
    // GEO LOCATION DATA (LATITUDE AND LONGITUDE)
    // =====================================================================
    function locate(callback) {
        var callback = callback || function(){};
        console.log("navigator: ", navigator);
        console.log("navigator.geolocation: ", navigator.geolocation);
        navigator && navigator.geolocation &&
        navigator.geolocation.getCurrentPosition(function(position) { 
            console.log("Retrieved a position of some sort...");
            p.location = [
                position.coords.latitude,
                position.coords.longitude
            ];
            callback(p.location);
        }) || callback([ 0, 0 ]); 
    }

    // =====================================================================
    // CREATE SOCKET
    // =====================================================================
    function get_socket(namespace) {
        var namespace = namespace
        ,   socket    = namespaces[namespace] || (function(){
                return namespaces[namespace] = {
                    namespace      : namespace,
                    connected      : false,
                    users          : users[namespace] = {},
                    user_count     : 1,
                    get_user_list  : function(){
                        return namespaces[namespace].users;
                    },
                    get_user_count : function(){
                        return namespaces[namespace].user_count;
                    },
                    emit : function( event, data, receipt ) {
                        send( event, namespace, data, 0, receipt );
                    },
                    send : function( data, receipt ) {
                        send( 'message', namespace, data, 0, receipt );
                    },
                    on : function( event, fn ) {
                        if (typeof event === 'string')
                            p.events.bind( namespace + event, fn );
                        else if (typeof event === 'object')
                            p.each( event, function(evt) {
                                p.events.bind( namespace + evt, fn );
                            } );
                    },
                    disconnect : function() {
                        delete namespaces[namespace];
                    }
                };
            })();

        return socket;
    }
})();
