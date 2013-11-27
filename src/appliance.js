/*
 * Copyright (c) 2013 - General Electric - Confidential - All Rights Reserved
 * 
 * Author: Christopher Baker <christopher.baker2@ge.com>
 *  
 */

var util = require("util");
var events = require("events");
var stream = require("binary-stream");

const MAX_SERIALIZED_LENGTH = 128;
const COMMAND_POLL_INTERVAL = 200;

const COMMAND_VERSION = 0x01;
const DISCOVERY_INTERVAL = 1000;

function arrayEquals (a, b) {
    for (var i = 0; i < a.length; i++) {
        if (a[i] != b[i]) return false;
    }
    
    return a.length == b.length;
}

function Item (type) {
    function parse (item) {
        var name, type, size, default_value;
        var split = item.split(":");
        
        if (split.length == 1) {
            // type@size
            split = split[0].split("@");
            type = split[0];
            size = split[1];
        }
        else {
            // name:type@size:default
            name = split[0];
            default_value = split[2];
            split = split[1].split("@");
            type = split[0];
            size = split[1];
        }
        
        return {
            name: name,
            type: type,
            size: size,
            default: default_value
        };
    }

    function read (reader, item, value) {
        var i = parse(item);
        value[i.name] = reader["read" + i.type](i.size);
    }
    
    function write (writer, item, value) {
        var i = parse(item);
        
        if (value[i.name] == undefined) {
            writer["write" + i.type](i.default);
        }
        else {
            writer["write" + i.type](i.value[i.name]);
        }
    }

    if (util.isArray(type.format)) {
        this.serialize = function (value, callback) {
            var writer = new stream.Writer(MAX_SERIALIZED_LENGTH, type.endian);
            
            for (var i = 0; i < type.format.length; i++) {
                write(writer, type.format[i], value);
            }
            
            callback(writer.toArray());
            delete writer;
        };
        
        this.deserialize = function (data, callback) {
            var reader = new stream.Reader(data, type.endian);
            var value = { };
            
            for (var i = 0; i < type.format.length; i++) {
                read(reader, type.format[i], value);
            }
            
            callback(value);
            delete reader;
        };
    }
    else {
        this.serialize = function (value, callback) {
            var i = parse(type.format);
            var writer = new stream.Writer(MAX_SERIALIZED_LENGTH, type.endian);
            writer["write" + i.type](value);
            callback(writer.toArray());
            delete writer;
        };
        
        this.deserialize = function (data, callback) {
            var i = parse(type.format);
            var reader = new stream.Reader(data, type.endian);
            var value = reader["read" + i.type](i.size);
            callback(value);
            delete reader;
        };
    }
}

util.inherits(Item, events.EventEmitter);

function Endpoint (bus, source, destination) {
    var self = this;
    this.address = destination;
    
    function isResponse (response) {
        return response.source == destination &&
            response.destination == source;
    }
    
    function isNotFiltered (message) {
        return message.destination == source ||
            message.destination == destination;
    }
    
    bus.on("message", function (message) {
        if (isNotFiltered(message)) {
            self.emit("message", message);
        }
    });
    
    bus.on("read", function (message, callback) {
        if (isNotFiltered(message)) {
            self.emit("read", message, callback);
        }
    });
    
    bus.on("write", function (message, callback) {
        if (isNotFiltered(message)) {
            self.emit("write", message, callback);
        }
    });
    
    this.send = function (command, data, callback) {
        if (callback) {
            function handle (response) {
                if (isResponse(response) && response.command == command) {
                    callback(response.data);
                }
                else {
                    bus.once("message", handle);
                }
            }
            
            bus.once("message", handle);
        }
        
        bus.send({
            command: command,
            data: data,
            source: source,
            destination: destination
        });
    };
    
    this.read = function (erd, callback) {
        if (callback) {
            function handle (response) {
                if (isResponse(response) && response.erd == erd) {
                    callback(response.data);
                }
                else {
                    bus.once("read-response", handle);
                }
            }
            
            bus.once("read-response", handle);
        }
    
        bus.read({
            erd: erd,
            source: source,
            destination: destination
        });
    };
    
    this.write = function (erd, data, callback) {
        if (callback) {
            function handle (response) {
                if (isResponse(response) && response.erd == erd) {
                    callback();
                }
                else {
                    bus.once("write-response", handle);
                }
            }
            
            bus.once("write-response", handle);
        }
    
        bus.write({
            erd: erd,
            data: data,
            source: source,
            destination: destination
        });
    };
    
    this.subscribe = function (erd, callback) {
        if (callback) {
            function handle (response) {
                if (isResponse(response) && response.erd == erd) {
                    callback(response.data);
                }
            }
            
            bus.on("publish", handle);
        }
    
        bus.subscribe({
            erd: erd,
            source: source,
            destination: destination
        });
    };
    
    this.publish = function (erd, data) {
        bus.publish({
            erd: erd,
            data: data,
            source: source,
            destination: destination
        });
    };
    
    this.item = function (type) {
        return new Item(type);
    };
    
    this.command = function (type) {
        var item = this.item(type);
        
        item.read = function (callback) {
            self.send(type.command, [], function (data) {
                item.deserialize(data, callback);
            });
        };
        
        item.write = function (value, callback) {
            item.serialize(value, function (data) {
                self.send(type.command, data, callback);
            });
        };
        
        item.subscribe = function (callback) {
            var state = [];
            
            function update () {
                self.send(type.command, [], function (data) {
                    if (!arrayEquals(state, data)) {
                        state = data;
                        item.deserialize(data, callback);
                    }
                });
            }
            
            setInterval(update, COMMAND_POLL_INTERVAL);
        };
        
        return item;
    };
    
    this.erd = function (type) {
        var item = this.item(type);
    
        item.read = function (callback) {
            self.read(type.erd, function (data) {
                item.deserialize(data, callback);
            });
        };
        
        item.write = function (value, callback) {
            item.serialize(value, function (data) {
                self.write(type.erd, data, callback);
            });
        };
        
        item.subscribe = function (callback) {
            self.subscribe(type.erd, function (data) {
                item.deserialize(data, callback);
            });
        };
        
        self.on("read", function (request, callback) {
            if (request.erd == request.erd) {
                item.emit("read", function (value) {
                    item.serialize(value, callback);
                });
            }
        });
        
        return item;
    };
}

util.inherits(Endpoint, events.EventEmitter);

function Appliance (bus, source, destination, version) {
    var endpoint = new Endpoint(bus, source, destination);
    endpoint.version = version;
    
    return endpoint;
}

exports.plugin = function (bus, configuration, callback) {
    var appliances = [];
    
    bus.on("message", function (message) {
        if (message.command == COMMAND_VERSION) {
            if (message.data.length == 0) {
                if (configuration.version) {
                    bus.send({
                        command: COMMAND_VERSION,
                        data: configuration.version,
                        source: configuration.address,
                        destination: message.source
                    });
                }
            }
            else {
                if (appliances[message.source]) {
                    /* we already have the appliance in the list */
                }
                else {
                    var appliance = new Appliance(bus,
                        message.destination, message.source, message.data);
                        
                    appliances[message.source] = appliance;
                    bus.emit("appliance", appliance);
                }
            }
        }
    });
    
    bus.endpoint = function (address) {
        return new Endpoint(bus, configuration.address, address);
    };
    
    bus.create = function (name, callback) {
        callback(bus.endpoint(configuration.address));
    };
    
    function discover() {
        bus.send({ command: COMMAND_VERSION });
    }
    
    setInterval(discover, DISCOVERY_INTERVAL);
    discover();
    
    callback(bus);
};
