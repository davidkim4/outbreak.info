import axios from "axios";
import {
  from,
  of ,
  forkJoin,
  BehaviorSubject
} from "rxjs";
import {
  finalize,
  catchError,
  pluck,
  map,
  mergeMap,
} from "rxjs/operators";
import {
  timeParse,
  timeFormat,
  format,
  timeDay,
  timeMonday,
  nest,
  mean,
  min,
  max,
  median,
  quantile,
  sum,
  range,
  scaleOrdinal
} from "d3";

import {
  bin
} from "d3-array";

import {
  getEpiTraces
} from "@/api/epi-traces.js";

import CURATED from "@/assets/genomics/curated_lineages.json";
import MUTATIONS from "@/assets/genomics/curated_mutations.json";
import NT_MAP from "@/assets/genomics/sarscov2_NC045512_genes_nt.json";

import orderBy from "lodash/orderBy";
import uniq from "lodash/uniq";
import cloneDeep from "lodash/cloneDeep";

const parseDate = timeParse("%Y-%m-%d");
const formatDate = timeFormat("%e %B %Y");
const formatDateTime = timeFormat("%e %B %Y %I:%M %p");
const formatDateShort = timeFormat("%e %b %Y");
const formatPercent = format(".0%");

import store from "@/store";

function capitalize(value) {
  if (!value) return ''
  value = value.toString()
  return value != "of" ? value.charAt(0).toUpperCase() + value.slice(1) : value
}

function titleCase(value) {
  if (value) {
    const values = value.split(" ");
    return values.map(d => capitalize(d)).join(" ");
  }
}

export function lookupLineageDetails(apiurl, mutationObj, prevalenceThreshold) {
  const queryStr = mutationObj.reportQuery.muts ?
    `pangolin_lineage=${mutationObj.reportQuery.pango}&mutations=${mutationObj.reportQuery.muts}` :
    `pangolin_lineage=${mutationObj.reportQuery.pango}`
  return forkJoin([getVariantTotal(apiurl, queryStr)]).pipe(
    map(([total]) => {
      mutationObj["lineage_count"] = total;

      // sort the mutation synonyms
      if (mutationObj.mutation_synonyms) {
        mutationObj.mutation_synonyms.sort();
      }

      // translate dates into human readable formats
      if (mutationObj.dateModified) {
        const parsedDate = parseDate(mutationObj.dateModified);
        mutationObj["dateModifiedFormatted"] = formatDateShort(parsedDate);
      }

      // sort the classifications, format the dates
      if (mutationObj.classifications) {
        mutationObj.classifications = orderBy(mutationObj.classifications, ["author"], ["asc"]);
        // mutationObj.classifications = orderBy(mutationObj.classifications, [reportIDSorter, "dateModified", "author"], ["asc"]);

        mutationObj.classifications.forEach(d => {
          const parsedDate = parseDate(d.dateModified);
          d["dateModifiedFormatted"] = parsedDate ? formatDateShort(parsedDate) : null;
        })

        // Add outbreak's classification on the first instance
        if (!mutationObj.classifications.filter(d => d.author == "outbreak").length) {
          const outbreakVariantType = mutationObj.variantType == "Variant of Concern" ? "VOC" : mutationObj.variantType == "Variant of Interest" ? "VOI" : "VUM";
          mutationObj.classifications.push({
            author: "outbreak",
            dateModified: mutationObj.dateModified,
            dateModifiedFormatted: formatDateShort(parseDate(mutationObj.dateModified)),
            variantType: outbreakVariantType
          })
        }

        // create classification table
        mutationObj["classificationTable"] = nest()
          .key(d => d.variantType)
          // .key(d => d.author)
          .rollup(values => {
            let obj = {};
            // WARNING: this assumes that there aren't duplicate author keys.
            // should be okay if the curation is okay.
            values.forEach(d => {
              const reportLink = d.url && d.dateModifiedFormatted ? `<a href="${d.url}" target="_blank">${d.dateModifiedFormatted}</a>` :
                d.url ? `<a href="${d.url}" target="_blank">report</a>` :
                d.dateModifiedFormatted ? d.dateModifiedFormatted :
                null;

              const reportType = d.variantType == "VOC" ? "Variant of Concern" : d.variantType == "VOI" ? "Variant of Interest" : d.variantType == "VUI" ? "Variants under Investigation" : d.variantType == "VUM" ? "Variants under Monitoring" : null;

              const ttip = reportLink ? d.author == "outbreak" ? `<b>${reportType}</b> classification by <b>outbreak.info</b>` : `View <b>${reportType}</b> classification by <b>${d.author}</b>` : null;

              obj[d.author] = {
                dateModified: d.dateModifiedFormatted,
                url: d.url,
                report: reportLink,
                ttip: ttip
              };
            })
            return (obj)
          })
          .entries(mutationObj.classifications);

        mutationObj["classificationTable"] = arr2Obj(mutationObj["classificationTable"], "key", "value");
      }

    })
  )

}

function arr2Obj(arr, keyVar, valVar) {
  const transformed = arr.reduce((r, e) => {
    r[e[keyVar]] = e[valVar];
    return (r)
  }, {});

  return (transformed)
}

// sort the mutations by position within the genes
function compareMutationLocation(a, b) {
  if (!(a.gene in NT_MAP) || !(b.gene in NT_MAP))
    return 0;
  if (NT_MAP[a.gene].start < NT_MAP[b.gene].start)
    return -1;
  if (NT_MAP[a.gene].start > NT_MAP[b.gene].start)
    return 0;
  return (a.codon_num < b.codon_num ? -1 : 0);
}


function addTotal2Mutation(apiurl, mutation) {
  return (getVariantTotal(apiurl, `mutations=${mutation.mutation_name}`)).pipe(
    map(total => {
      mutation["lineage_count"] = total;
    })
  )
}

export function addTotals2Mutations(apiurl) {
  return forkJoin(...MUTATIONS.map(mutation => addTotal2Mutation(apiurl, mutation)))
}

export function getCuratedMutations(apiurl, prevalenceThreshold) {
  const query = MUTATIONS.map(mutation => mutation.mutation_name).join(" AND ");

  return forkJoin([getMutationsByLineage(apiurl, query, prevalenceThreshold, false), addTotals2Mutations(apiurl)]).pipe(
    map(([lineagesByMutation, totals]) => {
      // sort by codon num, then alpha
      let curated = orderBy(MUTATIONS, ["codon_num", "mutation_name"]);

      // Merge in the lineages
      curated.forEach(mutation => {
        mutation["lineages"] = lineagesByMutation[mutation.mutation_name].map(d => d.pangolin_lineage);
      })

      // nest by MOC/MOI
      curated = nest()
        .key(d => d.variantType)
        .entries(curated);

      curated.forEach(d => {
        d["id"] = d.key == "Mutation of Concern" ? "moc" : d.key == "Mutation of Interest" ? "moi" : "unknown";
      })

      curated = orderBy(curated, [reportTypeSorter], ["asc"]);
      return (curated)
    })
  )
}

export function getCuratedList(apiurl, prevalenceThreshold) {
  const query = CURATED.map(d => d.mutation_name).join(",");

  return forkJoin([getCharacteristicMutations(apiurl, query, prevalenceThreshold, false), ...CURATED.map(mutation => lookupLineageDetails(apiurl, mutation, prevalenceThreshold))]).pipe(
    map(([charMuts, totals]) => {
      // pull out the characteristic mutations and bind to the curated list.
      let curated = orderBy(CURATED, ["variantType", "mutation_name"]);
      curated.forEach(report => {
        report["mutations"] = charMuts[report.mutation_name.replace(/\+/g, "AND")] ? charMuts[report.mutation_name.replace(/\+/g, "AND")] : [];
      })

      const voc = curated.filter(d => d.variantType == "Variant of Concern").map(d => d.pangolin_lineage);
      const voi = curated.filter(d => d.variantType == "Variant of Interest").map(d => d.pangolin_lineage);

      curated = nest()
        .key(d => d.variantType)
        .entries(curated);

      curated.forEach(d => {
        d["id"] = d.key == "Variant of Concern" ? "voc" : d.key == "Variant of Interest" ? "voi" : "unknown";
      })

      curated = orderBy(curated, [reportTypeSorter], ["asc"]);

      return ({
        md: curated,
        voc: voc,
        voi: voi
      })
    })
  )
}

function getVariantSynonyms(md) {
  md.forEach(group => {
    group.values.forEach(report => {
      // merge mutation synonyms
      if (report["mutation_synonyms"]) {
        report["mutation_synonyms"] = report["mutation_synonyms"].concat(report.mutation_name, report.who_name, report.phe_name, report.nextstrain_clade, report.gisaid_clade)
      } else {
        report["mutation_synonyms"] = [report.mutation_name, report.who_name, report.phe_name, report.nextstrain_clade, report.gisaid_clade]
      }
      report.mutation_synonyms = uniq(report.mutation_synonyms).filter(d => d);
    })
  })
}

export function getReportList(apiurl, prevalenceThreshold = store.state.genomics.characteristicThreshold) {
  store.state.admin.reportloading = true;

  return forkJoin([getDateUpdated(apiurl), getCuratedList(apiurl, prevalenceThreshold), getCuratedMutations(apiurl, prevalenceThreshold)]).pipe(
    map(([dateUpdated, md, muts]) => {

      // combine all the variant synoynms together
      getVariantSynonyms(md.md);

      return ({
        ...md,
        dateUpdated: dateUpdated.lastUpdated,
        mutations: muts
      })

    }),
    catchError(e => {
      console.log("%c Error in getting report list data!", "color: red");
      console.log(e);
      return ( of ([]));
    }),
    finalize(() => store.state.admin.reportloading = false)
  )
}

function filterCuratedTypes(d) {
  return ((d.variantType == "Variant of Concern" || d.variantType == "Variant of Interest" || d.variantType == "Mutation of Concern") && d.reportType != "Lineage + Mutation");
}

export function getLocationBasics(apiurl) {
  store.state.admin.reportloading = true;
  let ofInterest = CURATED.filter(d => d.variantType).filter(d => filterCuratedTypes(d));
  ofInterest = orderBy(ofInterest, [locationTableSorter, "mutation_name"]);

  const curated = nest()
    .key(d => d.variantType)
    .rollup(values => values.map(d => d.mutation_name))
    .entries(ofInterest);

  return forkJoin([getSequenceCount(apiurl, null, true), getDateUpdated(apiurl)]).pipe(
    map(([total, dateUpdated]) => {
      return ({
        dateUpdated: dateUpdated.lastUpdated,
        total: total,
        curated: curated
      })

    }),
    catchError(e => {
      console.log("%c Error in getting report list data!", "color: red");
      console.log(e);
      return ( of ([]));
    }),
    finalize(() => store.state.admin.reportloading = false)
  )
}

export function buildQueryStr(lineageString, mutationString) {
  var queryStr = "";
  if (lineageString) {
    queryStr += `pangolin_lineage=${lineageString}`;
  }
  if (mutationString) {
    queryStr += `&mutations=${mutationString}`;
  }
  return queryStr;
}


export function getReportData(apiurl, locations, mutationString, lineageString, location, totalThreshold, defaultLocations = ["USA", "USA_US-CA"]) {
  // clean up the locations data
  // ensure it's an array
  locations = typeof(locations) == "string" ? [locations] : locations;
  // if not specified, use the default
  if (!locations) {
    locations = defaultLocations;
  }
  // if "selected" isn't included in the locations, add it.
  if (!locations.includes(location)) {
    locations.push(location);
  }
  // add the world
  locations.push("Worldwide");

  // ensure locations are unique
  locations = uniq(locations);

  var queryStr = buildQueryStr(lineageString, mutationString);
  store.state.admin.reportloading = true;
  const md = lineageString ? getCuratedMetadata(lineageString) : getCuratedMetadata(mutationString);

  return forkJoin([
    getDateUpdated(apiurl),
    findAllLocationMetadata(apiurl, locations, location),
    getTemporalPrevalence(apiurl, location, queryStr, null),
    getCumPrevalences(apiurl, queryStr, locations, totalThreshold),
    getPositiveLocations(apiurl, queryStr, "Worldwide"),
    getPositiveLocations(apiurl, queryStr, "USA"),
    getLocationPrevalence(apiurl, queryStr, location),
    getCharacteristicMutations(apiurl, lineageString),
    getMutationDetails(apiurl, mutationString),
    getMutationsByLineage(apiurl, mutationString)
  ]).pipe(
    map(([dateUpdated, locations, longitudinal, locPrev, countries, states, byCountry, mutations, mutationDetails, mutationsByLineage]) => {
      const characteristicMuts = md && md.mutations && md.mutations.length && md.mutations.flatMap(Object.keys).length ? md.mutations : mutations;

      // attach names to cum prevalences
      locPrev.forEach(d => {
        const filtered = locations.filter(loc => loc.id === d.id);
        if (filtered.length === 1) {
          d["name"] = filtered[0].label;
        }
      })

      return ({
        dateUpdated: dateUpdated,
        locations: locations,
        longitudinal: longitudinal,
        locPrev: locPrev,
        byCountry: byCountry,
        countries: countries,
        states: states,
        md: md,
        mutations: characteristicMuts,
        mutationDetails: mutationDetails,
        mutationsByLineage: mutationsByLineage
      })
    }),
    catchError(e => {
      console.log("%c Error in getting initial report data!", "color: red");
      console.log(e);
      return ( of ([]));
    }),
    finalize(() => store.state.admin.reportloading = false)
  )
}

export function updateLocationData(apiurl, mutationString, lineageString, locations, location, totalThreshold) {
  var queryStr = buildQueryStr(lineageString, mutationString);
  store.state.admin.reportloading = true;

  if(!locations || !locations.length) {
    locations = [location];
  }

  locations.push("Worldwide");

  // ensure locations are unique
  locations = uniq(locations);

  return forkJoin([
    findAllLocationMetadata(apiurl, locations, location),
    getTemporalPrevalence(apiurl, location, queryStr, null),
    getLocationPrevalence(apiurl, queryStr, location),
    getCumPrevalences(apiurl, queryStr, locations, totalThreshold)
  ]).pipe(
    map(([locations, longitudinal, byLocation, locPrev]) => {
      // attach names to cum prevalences
      locPrev.forEach(d => {
        const filtered = locations.filter(loc => loc.id === d.id);
        if (filtered.length === 1) {
          d["name"] = filtered[0].label;
        }
      })

      return ({
        locations: locations,
        longitudinal: longitudinal,
        byCountry: byLocation,
        locPrev: locPrev
      })
    }),
    catchError(e => {
      console.log("%c Error in updating report location data!", "color: red");
      console.log(e);
      return ( of ([]));
    }),
    finalize(() => store.state.admin.reportloading = false)
  )
}

export function getMutationDetails(apiurl, mutationString) {
  if (!mutationString)
    return ( of ([]));
  const timestamp = Math.round(new Date().getTime() / 36e5);
  const url = `${apiurl}mutation-details?mutations=${mutationString}&timestamp=${timestamp}`;
  return from(axios.get(url, {
    headers: {
      "Content-Type": "application/json"
    }
  })).pipe(
    pluck("data", "results"),
    map(results => {
      return (results)
    }),
    catchError(e => {
      console.log("%c Error in getting mutation details!", "color: red");
      console.log(e);
      return ( of ([]));
    })
  )
}

export function getMutationsByLineage(apiurl, mutationString, proportionThreshold = 0, returnFlat = true) {
  if (!mutationString)
    return ( of ([]));
  const timestamp = Math.round(new Date().getTime() / 36e5);
  const url = `${apiurl}mutations-by-lineage?mutations=${mutationString}&timestamp=${timestamp}&frequency=${proportionThreshold}`;
  return from(axios.get(url, {
    headers: {
      "Content-Type": "application/json"
    }
  })).pipe(
    pluck("data", "results"),
    map(results => {
      if (returnFlat) {
        let res = Object.keys(results).map(mutation_key => results[mutation_key].map(
          d => {
            d["mutation_string"] = mutation_key;
            d["pangolin_lineage"] = d["pangolin_lineage"].toUpperCase();
            d["proportion_formatted"] = d.proportion >= 0.005 ? formatPercent(d["proportion"]) : "< 0.5%";
            return (d);
          }
        ));
        return ([].concat(...res));
      } else {
        Object.keys(results).forEach(mutation_key => {
          results[mutation_key].sort((a, b) => a.pangolin_lineage < b.pangolin_lineage ? -1 : 1);
        })
        return (results)
      }
    }),
    catchError(e => {
      console.log("%c Error in getting mutations by lineage!", "color: red");
      console.log(e);
      return ( of ([]));
    })
  )
}

export function getCharacteristicMutations(apiurl, lineage, prevalenceThreshold = store.state.genomics.characteristicThreshold, returnFlat = true) {
  const timestamp = Math.round(new Date().getTime() / 36e5);
  if (!lineage)
    return ( of ([]));

  // convert + to AND to specify lineages + mutations
  const url = `${apiurl}lineage-mutations?pangolin_lineage=${lineage.replace(/\+/g, "AND")}&frequency=${prevalenceThreshold}`;
  return from(axios.get(url, {
    headers: {
      "Content-Type": "application/json"
    }
  })).pipe(
    pluck("data", "results"),
    map(results => {
      if (returnFlat) {
        let res = Object.keys(results).map(lineage_key => results[lineage_key].map(
          d => {
            d["pangolin_lineage"] = lineage_key.replace(/AND/g, "+");
            d["id"] = d.mutation.replace(/:/g, "_").replace(/\//g, "_").replace(/\s\+\s/g, "--").replace(/:/g, "_");
            return (d);
          }
        ));
        return ([].concat(...res));
      } else {
        Object.keys(results).forEach(lineage_key => {
          results[lineage_key].forEach(d => {
            d["pangolin_lineage"] = lineage_key;
            d["id"] = d.mutation.replace(/:/g, "_").replace(/\//g, "_").replace(/\s\+\s/g, "--").replace(/:/g, "_");
            d["mutation_simplified"] = d.type == "substitution" ? `${d.ref_aa}${d.codon_num}${d.alt_aa}` : d.mutation.split(":")[1].toUpperCase();
          })
          // sort by location
          results[lineage_key].sort(compareMutationLocation);
        })
        return (results)
      }
    }),
    catchError(e => {
      console.log("%c Error in getting characteristic mutations!", "color: red");
      console.log(e);
      return ( of ([]));
    })
  )
}


export function getMostRecentSeq(apiurl, mutationString, mutationVar) {
  const timestamp = Math.round(new Date().getTime() / 36e5);
  const url = `${apiurl}most-recent-collection-date-by-location?${mutationVar}=${mutationString}&timestamp=${timestamp}`;
  return from(axios.get(url, {
    headers: {
      "Content-Type": "application/json"
    }
  })).pipe(
    pluck("data", "results"),
    map(results => {
      let lineageRecent;
      if (results.length == 1) {
        results = filtered[0];
        const dateTime = parseDate(lineageRecent.date)
        lineageRecent["dateFormatted"] = dateTime ? formatDate(dateTime) : null;
      }
      return (lineageRecent)
    }),
    catchError(e => {
      console.log("%c Error in getting recent global prevalence data!", "color: red");
      console.log(e);
      return ( of ([]));
    })
  )
}

export function getCumPrevalences(apiurl, queryStr, locations, totalThreshold) {
  return forkJoin(...locations.map(d => getCumPrevalence(apiurl, queryStr, d, totalThreshold))).pipe(
    map(results => {
      results.sort((a, b) => b.global_prevalence - a.global_prevalence);

      return (results)
    }),
    catchError(e => {
      console.log("%c Error in getting recent local cumulative prevalence data for all locations!", "color: red");
      console.log(e);
      return ( of ([]));
    })
  )
}

export function getVariantTotal(apiurl, queryStr, formatted = true) {
  const timestamp = Math.round(new Date().getTime() / 36e5);
  const url = `${apiurl}global-prevalence?cumulative=true&${queryStr}&timestamp=${timestamp}`;
  return from(axios.get(url, {
    headers: {
      "Content-Type": "application/json"
    }
  })).pipe(
    pluck("data", "results"),
    map(results => {
      if (formatted) {
        return (format(",")(results.lineage_count))
      }
      return (results.lineage_count);
    }),
    catchError(e => {
      console.log(`%c Error in getting total cumulative prevalence data for ${queryStr}!`, "color: red");
      console.log(e);
      return ( of ([]));
    })
  )

}

export function getCumPrevalence(apiurl, queryStr, location, totalThreshold) {
  const timestamp = Math.round(new Date().getTime() / 36e5);
  const url = location == "Worldwide" ?
    `${apiurl}global-prevalence?cumulative=true&${queryStr}&timestamp=${timestamp}` :
    `${apiurl}prevalence-by-location?${queryStr}&location_id=${location}&cumulative=true&timestamp=${timestamp}`;
  return from(axios.get(url, {
    headers: {
      "Content-Type": "application/json"
    }
  })).pipe(
    pluck("data", "results"),
    map(results => {
      const first = parseDate(results.first_detected);
      const last = parseDate(results.last_detected);

      results["id"] = location;
      results["first_detected"] = first ? formatDateShort(first) : null;
      results["last_detected"] = last ? formatDateShort(last) : null;
      if (results.total_count >= totalThreshold) {
        results["proportion_formatted"] = results.lineage_count ? (results.global_prevalence < 0.005 ? "< 0.5%" : formatPercent(results.global_prevalence)) : "not detected";
      } else {
        results["proportion_formatted"] = results.lineage_count ? "no estimate" : "not detected";
      }

      results["lineage_count_formatted"] = format(",")(results.lineage_count);
      return (results)
    }),
    catchError(e => {
      console.log(`%c Error in getting recent local cumulative prevalence data for location ${location}!`, "color: red");
      console.log(e);
      return ( of ([]));
    })
  )
}

export function getNewTodayAll(apiurl, queryStr, locations) {
  return forkJoin(getNewToday(apiurl, queryStr, "Worldwide", null), ...locations.filter(d => d.type != "world").map(d => getNewToday(apiurl, queryStr, d.name, d.type))).pipe(
    map(results => {
      results.sort((a, b) => b.date_count_today - a.date_count_today);

      return (results)
    }),
    catchError(e => {
      console.log("%c Error in getting new today data for all locations!", "color: red");
      console.log(e);
      return ( of ([]));
    })
  )
}

export function getNewToday(apiurl, queryStr, location) {
  const timestamp = Math.round(new Date().getTime() / 36e5);
  const url = location == "Worldwide" ? `${apiurl}most-recent-submission-date-by-location?${queryStr}&timestamp=${timestamp}` :
    `${apiurl}most-recent-submission-date-by-location?${queryStr}&location_id=${location}&timestamp=${timestamp}`;
  return from(axios.get(url, {
    headers: {
      "Content-Type": "application/json"
    }
  })).pipe(
    pluck("data", "results"),
    map(results => {
      let result;
      if (results.length == 1) {
        result = results[0];
        result["dateTime"] = parseDate(result.date);
        const timeDiff = timeDay.count(result.dateTime, new Date());
        if (timeDiff < 2) {
          return ({
            name: location,
            date_count_today: format(",")(result.date_count)
          })
        } else {
          return ({
            name: location,
            date_count_today: 0
          })
        }
      } else {
        return ({
          name: location,
          date_count_today: null
        })
      }
    }),
    catchError(e => {
      console.log(`%c Error in getting new today data for location ${location}!`, "color: red");
      console.log(e);
      return ( of ([]));
    })
  )
}

export function getAllLocationPrevalence(apiurl, mutation, location, ndays = null) {
  return (getLocationPrevalence(apiurl, mutation.query, location, ndays).pipe(
    map(results => {
      return ({
        key: mutation.label,
        variantType: mutation.variantType,
        route: mutation.route,
        values: results
      })
    })
  ))
}

export function getLocationPrevalence(apiurl, queryStr, location, ndays = null) {
  const timestamp = Math.round(new Date().getTime() / 36e5);

  let url;
  url = location == "Worldwide" ?
    `${apiurl}lineage-by-sub-admin-most-recent?${queryStr}&timestamp=${timestamp}` :
    `${apiurl}lineage-by-sub-admin-most-recent?location_id=${location}&${queryStr}&timestamp=${timestamp}`;

  if (ndays) {
    url += `&ndays=${ndays}`;
  }
  return from(axios.get(url, {
    headers: {
      "Content-Type": "application/json"
    }
  })).pipe(
    pluck("data", "results"),
    map(results => {
      results.forEach(d => {
        d["proportion_formatted"] = formatPercent(d.proportion);
        // Shim to fix confusion over dates, https://github.com/outbreak-info/outbreak.info/issues/247
        d["date_last_detected"] = d.date;
        delete d.date;
        // fixes the Georgia (state) / Georgia (country) problem
        d["location_id"] = location == "Worldwide" ? `country_${d.name.replace(/\s/g, "")}` : d.name.replace(/\s/g, "");
      })
      return (results)
    }),
    catchError(e => {
      console.log("%c Error in getting recent prevalence data by country!", "color: red");
      console.log(e);
      return ( of ([]));
    })
  )
  // } else {
  //   return ( of ([]))
  // }
}

export function getPositiveLocations(apiurl, queryStr, location) {
  const timestamp = Math.round(new Date().getTime() / 36e5);
  let url;
  if (location == "Worldwide") {
    url = `${apiurl}lineage-by-sub-admin-most-recent?${queryStr}&detected=true&timestamp=${timestamp}`;
  } else {
    url = `${apiurl}lineage-by-sub-admin-most-recent?${queryStr}&detected=true&location_id=${location}&timestamp=${timestamp}`;
  }

  return from(axios.get(url, {
    headers: {
      "Content-Type": "application/json"
    }
  })).pipe(
    pluck("data", "results", "names"),
    map(results => {
      return results
    }),
    catchError(e => {
      console.log("%c Error in getting list of positive country names!", "color: red");
      console.log(e);
      return ( of ([]));
    })
  )
}

export function getTemporalPrevalence(apiurl, location, queryStr, indivCall = false) {
  store.state.admin.reportloading = true;
  const timestamp = Math.round(new Date().getTime() / 36e5);
  let url;
  if (location == "Worldwide") {
    url = `${apiurl}global-prevalence?${queryStr}&timestamp=${timestamp}`;
  } else {
    url = `${apiurl}prevalence-by-location?${queryStr}&location_id=${location}&timestamp=${timestamp}`;
  }

  return from(axios.get(url, {
    headers: {
      "Content-Type": "application/json"
    }
  })).pipe(
    pluck("data", "results"),
    map(results => {
      results.forEach(d => {
        d["dateTime"] = parseDate(d.date);
      })
      return (results)
    }),
    catchError(e => {
      console.log("%c Error in getting temporal data by location!", "color: red");
      console.log(e);
      return of([]);
    }),
    finalize(() => indivCall ? store.state.admin.reportloading = false : null)
  )
}


export function getCuratedMetadata(id) {
  const curated = CURATED.filter(d => d.mutation_name == id);
  if (curated.length === 1) {
    return (curated[0])
  }
}

export function getLineageResources(apiurl, queryString, size, page, sort = "-date") {
  const fields = "@type, name, author, date, journalName"
  const timestamp = Math.round(new Date().getTime() / 36e5);


  return from(
    axios.get(`${apiurl}query?q=${queryString}&sort=${sort}&size=${size}&from=${page}&fields=${fields}&timestamp=${timestamp}`, {
      headers: {
        "Content-Type": "application/json"
      }
    })
  ).pipe(
    pluck("data"),
    map(results => {
      results["hits"].forEach(d => {
        const parsedDate = parseDate(d.date)
        d["dateFormatted"] = parsedDate ? formatDate(parsedDate) : null;
      })

      return ({
        resources: results["hits"],
        total: results["total"]
      })
    }),
    catchError(e => {
      console.log("%c Error in getting resource metadata!", "color: red");
      console.log(e);
      return ( of ([]));
    })
  )

}

export function findLocationMetadata(apiurl, location) {
  const timestamp = Math.round(new Date().getTime() / 8.64e7);
  const url = `${apiurl}location-lookup?id=${location}&timestamp=${timestamp}`
  if (location) {
    return from(
      axios.get(url, {
        headers: {
          "Content-Type": "application/json"
        }
      })
    ).pipe(
      pluck("data", "results"),
      map(results => {
        results["id"] = location;
        return (results)
      }),
      catchError(e => {
        console.log("%c Error in getting location metadata!", "color: red");
        console.log(e);
        return ( of ([]));
      })
    )
  } else {
    return ( of (null))
  }
}

export function findAllLocationMetadata(apiurl, locations, selected) {
  locations = locations.filter(d => d != "Worldwide");

  return forkJoin(...locations.map(location => findLocationMetadata(apiurl, location))).pipe(
    map(results => {
      // add in a Worldwide default location
      results = [{
        id: "Worldwide",
        label: "Worldwide",
        admin_level: -1,
        query_id: "Worldwide"
      }].concat(results)

      // set the active place
      results.forEach(d => {
        d["isActive"] = d.id === selected;
      })
      return (results)
    }),
    catchError(e => {
      console.log("%c Error in getting all location metadata!", "color: orange");
      console.log(e);
      return ( of ([]));
    })
  )
}

export function findLocation(apiurl, queryString) {
  const timestamp = Math.round(new Date().getTime() / 8.64e7);
  const url = `${apiurl}location?name=*${queryString}*&timestamp=${timestamp}`

  return from(
    axios.get(url, {
      headers: {
        "Content-Type": "application/json"
      }
    })
  ).pipe(
    pluck("data", "results"),
    map(results => {
      return (results)
    }),
    catchError(e => {
      console.log("%c Error in getting location names!", "color: red");
      console.log(e);
      return ( of ([]));
    })
  )
}

export function findPangolin(apiurl, queryString) {
  const timestamp = Math.round(new Date().getTime() / 8.64e7);
  const url = `${apiurl}lineage?name=*${queryString}*&timestamp=${timestamp}`;

  return from(
    axios.get(url, {
      headers: {
        "Content-Type": "application/json"
      }
    })
  ).pipe(
    pluck("data", "results"),
    map(results => {
      results.forEach(d => {
        d.name = d.name.toUpperCase();
      })

      return (results)
    }),
    catchError(e => {
      console.log("%c Error in getting Pangolin lineage names!", "color: red");
      console.log(e);
      return ( of ([]));
    })
  )
}

export function getDateUpdated(apiurl) {
  const timestamp = Math.round(new Date().getTime() / 8.64e7);
  const url = `${apiurl}metadata?timestamp=${timestamp}`;

  return from(
    axios.get(url, {
      headers: {
        "Content-Type": "application/json"
      }
    })
  ).pipe(
    pluck("data", "build_date"),
    map(result => {
      const today = new Date();
      let lastUpdated;
      const strictIsoParse = timeParse("%Y-%m-%dT%H:%M:%S.%f%Z");
      const dateUpdated = strictIsoParse(result); // ensure the time is parsed as PDT
      if (dateUpdated) {
        const updatedDiff = (today - dateUpdated) / (60 * 60 * 1000);

        if (updatedDiff < 1) {
          lastUpdated = `${Math.round(updatedDiff * 60)}m`;
        } else if (updatedDiff <= 24) {
          lastUpdated = `${Math.round(updatedDiff)}h`;
        } else {
          lastUpdated = `${Math.round(updatedDiff / 24)}d`;
        }
      }

      return ({
        dateUpdated: formatDateTime(dateUpdated),
        lastUpdated: lastUpdated
      })
    }),
    catchError(e => {
      console.log("%c Error in getting date updated!", "color: red");
      console.log(e);
      return ( of ([]));
    })
  )
}
export function getCumPrevalenceAllLineages(apiurl, location, other_threshold, nday_threshold, ndays, window) {
  const timestamp = Math.round(new Date().getTime() / 8.64e7);
  let url = `${apiurl}prevalence-by-location-all-lineages?location_id=${location}&other_threshold=${other_threshold}&nday_threshold=${nday_threshold}&ndays=${ndays}&window=${window}&ndays=${ndays}&cumulative=true&timestamp=${timestamp}`;

  return from(
    axios.get(url, {
      headers: {
        "Content-Type": "application/json"
      }
    })
  ).pipe(
    pluck("data", "results"),
    map(results => {
      let wideData = {};
      results.sort((a, b) => b.prevalence - a.prevalence);

      results.forEach(d => {
        if (d.lineage == "other") {
          wideData["Other"] = d.prevalence
        } else {
          wideData[d.lineage.toUpperCase()] = d.prevalence
        }

      })

      return ([wideData])
    }),
    catchError(e => {
      console.log("%c Error in getting cumulative prevalence for all lineages in a place!", "color: yellow");
      console.log(e);
      return ( of ([]));
    })
  )
}

export function getPrevalenceAllLineages(apiurl, location, other_threshold, nday_threshold, ndays) {
  const dateThreshold = new Date("2020-03-14");
  const timestamp = Math.round(new Date().getTime() / 8.64e7);
  let url = `${apiurl}prevalence-by-location-all-lineages?location_id=${location}&other_threshold=${other_threshold}&nday_threshold=${nday_threshold}&ndays=${ndays}&timestamp=${timestamp}`;

  return from(
    axios.get(url, {
      headers: {
        "Content-Type": "application/json"
      }
    })
  ).pipe(
    pluck("data", "results"),
    map(results => {

      results.forEach(d => {
        if (d.lineage == "other") {
          d["pangolin_lineage"] = "Other";
        } else {
          d["pangolin_lineage"] = d.lineage.toUpperCase();
        }

      })

      let nested = nest()
        .key(d => d.date)
        .rollup(values => {
          return ({
            values: values
          })
        })
        .entries(results);

      let lineages = uniq(results.map(d => d.pangolin_lineage));

      nested.sort((a, b) => a.key < b.key ? -1 : 1);

      const nested2 = nested.map(dateObj => {
        let obj = {}
        obj["date_time"] = parseDate(dateObj.key);

        lineages.forEach(lineage => {
          const filtered = dateObj.value.values.filter(d => d.pangolin_lineage === lineage);
          if (filtered.length === 1) {
            obj[lineage] = filtered[0].prevalence_rolling;
          } else {
            obj[lineage] = 0
          }
        })
        return (obj)
      })

      return (nested2.filter(d => d.date_time > dateThreshold))
    }),
    catchError(e => {
      console.log("%c Error in getting prevalence for all lineages in a place!", "color: red");
      console.log(e);
      return ( of ([]));
    })
  )
}

// LOCATION REPORTS
export function getBasicLocationReportData(apiurl, location) {
  store.state.genomics.locationLoading1 = true;
  let filtered = CURATED.filter(d => d.variantType).filter(d => filterCuratedTypes(d));
  filtered = orderBy(filtered, ["variantType", "mutation_name"]);

  const curatedLineages = filtered.map(d => {
    let reportQuery = d.reportQuery;
    reportQuery.loc = reportQuery.loc ? uniq(reportQuery.loc.push(location)) : [location];
    reportQuery.selected = location;

    return ({
      label: d.mutation_name,
      query: buildQueryStr(reportQuery.pango, reportQuery.muts),
      variantType: d.variantType,
      route: reportQuery
    })
  })

  return forkJoin([
    findLocationMetadata(apiurl, location),
    getDateUpdated(apiurl),
    getSequenceCount(apiurl, location, true)
  ]).pipe(
    map(([location, dateUpdated, total]) => {
      return ({
        location: location,
        dateUpdated: dateUpdated,
        curated: curatedLineages,
        total: total
      })
    }),
    catchError(e => {
      console.log("%c Error in getting basic location report data!", "color: red");
      console.log(e);
      return ( of ([]));
    }),
    finalize(() => store.state.genomics.locationLoading1 = false)
  )
}

export function getLocationReportData(apiurl, location, mutations, pango_lineages, other_threshold, nday_threshold, ndays, window) {
  store.state.genomics.locationLoading2 = true;

  return getLocationLineagePrevalences(apiurl, location, mutations, pango_lineages, other_threshold, nday_threshold, ndays, window)
    .pipe(
      mergeMap(results => getMutationsOfInterestPrevalence(apiurl, results.recentDomain).pipe(
        map(heatmap => {
          results["heatmap"] = heatmap;
          return (results)
        })
      )),
      catchError(e => {
        console.log("%c Error in getting location report data!", "color: red");
        console.log(e);
        return ( of ([]));
      }),
      finalize(() => store.state.genomics.locationLoading2 = false)
    )
}

export function getLocationLineagePrevalences(apiurl, location, mutations, pango_lineages, other_threshold, nday_threshold, ndays, window) {
  return forkJoin([
    getPrevalenceAllLineages(apiurl, location, other_threshold, nday_threshold, ndays),
    getCumPrevalenceAllLineages(apiurl, location, other_threshold, nday_threshold, ndays, window)
  ]).pipe(
    map(([lineagesByDay, mostRecentLineages]) => {
      if (mostRecentLineages && mostRecentLineages.length) {
        let recentDomain = Object.keys(mostRecentLineages[0]).filter(d => d != "Other");
        let lineageDomain = ["Other"].concat(recentDomain);

        lineageDomain = uniq(lineageDomain.concat(Object.keys(lineagesByDay[0]).filter(d => d != "Other" && d != "date_time")));

        return ({
          lineagesByDay: lineagesByDay,
          mostRecentLineages: mostRecentLineages,
          lineageDomain: lineageDomain,
          recentDomain: recentDomain
        })
      } else {
        let lineageDomain = ["Other"];

        lineageDomain = uniq(lineageDomain.concat(Object.keys(lineagesByDay[0]).filter(d => d != "Other" && d != "date_time")));

        return ({
          lineagesByDay: lineagesByDay,
          mostRecentLineages: mostRecentLineages,
          lineageDomain: lineageDomain,
          recentDomain: null
        })
      }
    }),
    catchError(e => {
      console.log("%c Error in getting location report data!", "color: red");
      console.log(e);
      return ( of ([]));
    })
  )
}

export function getLocationMaps(apiurl, location, mutations, ndays) {
  store.state.genomics.locationLoading5 = true;

  return forkJoin(...mutations.map(mutation => getAllLocationPrevalence(apiurl, mutation, location, ndays))).pipe(
    map(results => {
      results = orderBy(results, [locationTableSorter, "key"], ["asc", "asc"]);

      return (results)
    }),
    catchError(e => {
      console.log("%c Error in getting location mapping data!", "color: orange");
      console.log(e);
      return ( of ([]));
    }),
    finalize(() => store.state.genomics.locationLoading5 = false)
  )
}

export function getMutationCumPrevalence(apiurl, mutationObj, location, totalThreshold) {
  return (getCumPrevalence(apiurl, mutationObj.query, location, totalThreshold)).pipe(
    map(results => {
      return ({
        ...results,
        ...mutationObj
      })
    })
  )
}

export function getAllTemporalPrevalence(apiurl, location, mutationObj) {
  return (getTemporalPrevalence(apiurl, location, mutationObj.query)).pipe(
    map(results => {
      let data = cloneDeep(mutationObj)
      data["data"] = results;
      return (data)
    })
  )
}

function locationTableSorter(a) {
  const sortingArr = ["Variant of Concern", "Mutation of Concern", "Variant of Interest", "Custom Lineages & Mutations"];
  return sortingArr.indexOf(a.variantType);
}

function geneSorter(a) {
  const sortingArr = ["ORF1a",
    "ORF1b",
    "S",
    "ORF3a",
    "E",
    "M",
    "ORF6",
    "ORF7a",
    "ORF7b",
    "ORF8",
    "N",
    "ORF10"
  ];
  return sortingArr.indexOf(a.key);
}

function reportTypeSorter(a) {
  const sortingArr = ["Variant of Concern", "Variant of Interest", "Variant under Investigation", "Mutation of Concern", "Mutation of Interest", "undefined"];
  // const sortingArr = ["lineage", "lineage + mutation", "mutation"];
  return sortingArr.indexOf(a.key);
}

function reportIDSorter(a) {
  const sortingArr = ["VOC", "VOI", "VUI", "VUM", "unknown"];
  // const sortingArr = ["lineage", "lineage + mutation", "mutation"];
  return sortingArr.indexOf(a.variantType);
}

export function getLocationTable(apiurl, location, mutations, totalThreshold) {
  store.state.genomics.locationLoading3 = true;

  return forkJoin(...mutations.map(mutation => getMutationCumPrevalence(apiurl, mutation, location, totalThreshold))).pipe(
    map(results => {
      results = orderBy(results, [locationTableSorter, "global_prevalence"], ["asc", "desc"]);

      const nestedResults = nest()
        .key(d => d.variantType)
        .entries(results);

      return (nestedResults)
    }),
    catchError(e => {
      console.log("%c Error in getting location mapping data!", "color: orange");
      console.log(e);
      return ( of ([]));
    }),
    finalize(() => store.state.genomics.locationLoading3 = false)
  )
}

export function getEpiMutationPrevalence(apiurl, epiurl, locationID, mutations, epiFields = "location_id,date,confirmed,mostRecent,confirmed_numIncrease,confirmed_rolling,dead_numIncrease,dead_rolling") {
  store.state.genomics.locationLoading4 = true;

  return forkJoin([getEpiTraces(epiurl, [locationID], epiFields), getAllTemporalPrevalences(apiurl, locationID, mutations)]).pipe(
    map(([epi, mutationTraces]) => {
      epi = epi.length ? epi[0].value : [];
      // weird trailing undefined sometimes?
      epi = epi.filter(d => d.date);
      return ({
        epi: epi,
        mutations: mutationTraces
      })
    }),
    catchError(e => {
      console.log("%c Error in getting epi/mutation prevalence data!", "color: orange");
      console.log(e);
      return ( of ([]));
    }),
    finalize(() => store.state.genomics.locationLoading4 = false)
  )
}

export function getAllTemporalPrevalences(apiurl, locationID, mutations) {
  if (mutations.length) {
    return forkJoin(...mutations.map(mutation => getAllTemporalPrevalence(apiurl, locationID, mutation))).pipe(
      map(results => {
        return (results)
      }),
      catchError(e => {
        console.log("%c Error in getting mutations over time data!", "color: orange");
        console.log(e);
        return ( of ([]));
      }),
      finalize(() => store.state.genomics.locationLoading4 = false)
    )
  } else {
    return of([]);
  }
}

export function getSequenceCount(apiurl, location = null, cumulative = true, rounded = false) {
  let url = `${apiurl}sequence-count`;
  if (cumulative && location) {
    url += `?location_id=${location}&cumulative=true`;
  } else if (location) {
    url += `?location_id=${location}`
  } else if (cumulative) {
    url += "?cumulative=true";
  }
  const timestamp = Math.round(new Date().getTime() / 36e5);
  return from(axios.get(url, {
    headers: {
      "Content-Type": "application/json"
    }
  })).pipe(
    pluck("data", "results"),
    map(results => {
      if (rounded) {
        return (Math.floor(results.total_count / 1e5) / 10)
      }
      if (cumulative) {
        return (results.total_count.toLocaleString())
      } else {
        results.forEach(d => {
          d["dateTime"] = parseDate(d.date);
        })
        return (results)
      }
    }),
    catchError(e => {
      console.log("%c Error in getting total sequences for the location!", "color: red");
      console.log(e);
      return ( of ([]));
    })
  )
}

// COMPARISON REPORTS
export function getBasicComparisonReportData(apiurl) {
  store.state.genomics.locationLoading1 = true
  return forkJoin([
    getDateUpdated(apiurl),
    getSequenceCount(apiurl)
  ]).pipe(
    map(([dateUpdated, total]) => {
      return ({
        dateUpdated: dateUpdated,
        total: total
      })
    }),
    catchError(e => {
      console.log("%c Error in getting basic comparison report data!", "color: red");
      console.log(e);
      return ( of ([]));
    }),
    finalize(() => store.state.genomics.locationLoading1 = false)
  )
}

export function getMutationsOfInterestPrevalence(apiurl, lineages, prevalenceThreshold = store.state.genomics.characteristicThreshold) {
  const mutationsOfInterest = ["s:s477n", "s:n501y", "s:k417n", "s:k417t", "s:p681h", "s:p681r", "s:l18f", "s:s494p", "s:l452r", "s:n439k"];
  const mutationsOfConcern = ["s:e484k"];

  if (lineages && lineages.length) {
    return forkJoin([...lineages.map(lineage => getCharacteristicMutations(apiurl, lineage, 0))]).pipe(
      map((results, idx) => {
        const prevalentMutations = uniq(results.flatMap(d => d).filter(d => d.gene === "S").filter(d => d.prevalence > prevalenceThreshold).map(d => d.mutation));
        let moi = results.flatMap(d => d.filter(x => mutationsOfInterest.includes(x.mutation) || mutationsOfConcern.includes(x.mutation)));
        let characteristic = results.flatMap(d => d.filter(x => prevalentMutations.includes(x.mutation)));


        characteristic.forEach(d => {
          d["id"] = `${d.pangolin_lineage.replace(/\./g, "_").replace(/:/g, "_").replace(/\s\+\s/g, "--")}-${d.mutation.replace(/\//g, "_").replace(/:/g, "_")}`;
          d["mutation_simplified"] = d.type == "substitution" ? `${d.ref_aa}${d.codon_num}${d.alt_aa}` :
            d.type == "deletion" ? d.mutation.toUpperCase().split(":").slice(-1)[0] : d.mutation;
          d["isMOI"] = mutationsOfInterest.includes(d.mutation);
          d["isMOC"] = mutationsOfConcern.includes(d.mutation);
        })

        moi.forEach(d => {
          d["id"] = `${d.pangolin_lineage.replace(/\./g, "_").replace(/:/g, "_").replace(/\s\+\s/g, "--")}-${d.mutation.replace(/\//g, "_").replace(/:/g, "_")}`;
          d["mutation_simplified"] = d.type == "substitution" ? `${d.ref_aa}${d.codon_num}${d.alt_aa}` :
            d.type == "deletion" ? d.mutation.toUpperCase().split(":").slice(-1)[0] : d.mutation;
          d["isMOI"] = mutationsOfInterest.includes(d.mutation);
          d["isMOC"] = mutationsOfConcern.includes(d.mutation);
        })

        const charDomain = uniq(characteristic.map(d => d.pangolin_lineage));
        const moiDomain = uniq(moi.map(d => d.pangolin_lineage));

        return ({
          characteristic: {
            data: characteristic,
            yDomain: charDomain
          },
          moi: {
            data: moi,
            yDomain: moiDomain
          }
        })
      }),
      catchError(e => {
        console.log("%c Error in getting mutation prevalence by lineage!", "color: teal");
        console.log(e);
        return ( of ({
          characteristic: {
            data: [],
            yDomain: []
          },
          moi: {
            data: [],
            yDomain: []
          }
        }));
      })
    )
  } else {
    return ( of ({
      characteristic: {
        data: [],
        yDomain: []
      },
      moi: {
        data: [],
        yDomain: []
      }
    }))
  }
}

export function getComparisonByMutations(apiurl, lineages, prevalenceThreshold, mutationQuery, mutationThreshold) {
  return getMutationsByLineage(apiurl, mutationQuery, mutationThreshold).pipe(
    mergeMap(newLineages => {
      newLineages.sort((a, b) => b.proportion - a.proportion);
      const newPango = uniq(lineages.concat(newLineages.map(d => d.pangolin_lineage)));
      return getLineagesComparison(apiurl, newPango, prevalenceThreshold).pipe(
        map(results => {
          return {
            ...results,
            addedLength: newLineages.length
          }
        })
      )
    })
  )
}

export function getComparisonByLocation(apiurl, lineages, prevalenceThreshold, locationID, other_threshold, nday_threshold, ndays, window) {
  return getCumPrevalenceAllLineages(apiurl, locationID, other_threshold, nday_threshold, ndays, window).pipe(
    mergeMap(newLineages => {
      newLineages = Object.keys(newLineages[0]).filter(d => d.toLowerCase() != "other")
      // newLineages.sort((a, b) => b.proportion - a.proportion);
      const newPango = uniq(lineages.concat(newLineages));
      return getLineagesComparison(apiurl, newPango, prevalenceThreshold).pipe(
        map(results => {
          return {
            ...results,
            addedLength: newLineages.length
          }
        })
      )
    })
  )
}

export function getLineagesComparison(apiurl, lineages, prevalenceThreshold) {
  store.state.genomics.locationLoading2 = true;

  // if nothing selected, pull out the VOCs/VOIs
  if (!lineages) {
    lineages = orderBy(CURATED, ["variantType", "mutation_name"]);

    // Focus on Variants of Concern
    lineages = lineages.filter(d => d.variantType == "Variant of Concern");
    lineages = lineages.map(d => d.mutation_name);
  }

  const voc = CURATED.filter(d => d.variantType == "Variant of Concern").map(d => d.mutation_name);
  const voi = CURATED.filter(d => d.variantType == "Variant of Interest").map(d => d.mutation_name);

  return forkJoin([...lineages.map(lineage => getCharacteristicMutations(apiurl, lineage, 0))]).pipe(
    map((results, idx) => {
      const prevalentMutations = uniq(results.flatMap(d => d).filter(d => d.prevalence > prevalenceThreshold).map(d => d.mutation));

      let filtered = results.flatMap(d => d.filter(x => prevalentMutations.includes(x.mutation)))

      // const avgByMutation = nest()
      //   .key(d => d.mutation)
      //   .rollup(values => {
      //     const mutation = values[0].mutation;
      //     const mutation_count = sum(values, d => d.mutation_count);
      //     const lineage_count = sum(values, d => d.lineage_count);
      //     return ({
      //       mutation_count: mutation_count,
      //       lineage_count: lineage_count,
      //       // prevalence: mutation_count / lineage_count,
      //       prevalence: sum(values, d => d.prevalence) / (lineages.length - 1),
      //       pangolin_lineage: "average",
      //       mutation: mutation,
      //       gene: values[0].gene
      //     })
      //   })
      //   .entries(filtered).map(d => d.value);

      // filtered = filtered.concat(avgByMutation);

      filtered.forEach(d => {
        d["id"] = `${d.pangolin_lineage.replace(/\./g, "_").replace(/:/g, "_").replace(/\s\+\s/g, "--")}-${d.mutation.replace(/\//g, "_").replace(/:/g, "_")}`;
        d["mutation_simplified"] = d.type == "substitution" ? `${d.ref_aa}${d.codon_num}${d.alt_aa}` :
          d.type == "deletion" ? d.mutation.toUpperCase().split(":").slice(-1)[0] : d.mutation;
      })

      let nestedByGenes = nest()
        .key(d => d.gene)
        .entries(filtered);

      nestedByGenes = orderBy(nestedByGenes, geneSorter);

      return ({
        data: nestedByGenes,
        dataFlat: filtered,
        voc: voc,
        voi: voi,
        yDomain: lineages
      })
    }),
    catchError(e => {
      console.log("%c Error in getting comparison report data!", "color: pink");
      console.log(e);
      return ( of ([]));
    }),
    finalize(() => store.state.genomics.locationLoading2 = false)
  )
}


export function getBadMutations(returnSimplified = false) {
  const moc = MUTATIONS.filter(d => d.variantType == "Mutation of Concern");
  let moi = MUTATIONS.filter(d => d.variantType == "Mutation of Interest");

  moc.sort((a, b) => a.codon_num - b.codon_num);
  moi.sort((a, b) => a.codon_num - b.codon_num);

  if (returnSimplified) {
    return ({
      moc: moc.map(d => d.mutation_name.split(":")[1]),
      moi: moi.map(d => d.mutation_name.split(":")[1])
    })
  } else {
    return ({
      moc: moc.map(d => d.mutation_name),
      moi: moi.map(d => d.mutation_name)
    })
  }
}

// Lag functions
export function getStatusBasics(apiurl, location) {
  store.state.admin.reportloading = true;

  return forkJoin([getSequenceCount(apiurl, null, true), getDateUpdated(apiurl), findLocationMetadata(apiurl, location)]).pipe(
    map(([total, dateUpdated, location]) => {
      return ({
        dateUpdated: dateUpdated.dateUpdated,
        lastUpdated: dateUpdated.lastUpdated,
        total: total
      })

    }),
    catchError(e => {
      console.log("%c Error in getting status overview data!", "color: turquoise");
      console.log(e);
      return ( of ([]));
    }),
    finalize(() => store.state.admin.reportloading = false)
  )
}

export function getStatusLocation(apiurl, location) {
  store.state.admin.reportloading = true;

  return forkJoin([getSequenceCount(apiurl, location, true), findLocationMetadata(apiurl, location)]).pipe(
    map(([total, location]) => {
      return ({
        total: total,
        location: location
      })

    }),
    catchError(e => {
      console.log("%c Error in getting status location data!", "color: turquoise");
      console.log(e);
      return ( of ([]));
    }),
    finalize(() => store.state.admin.reportloading = false)
  )
}

export function getSeqGaps(apiurl, location) {
  store.state.genomics.locationLoading1 = true;
  const timestamp = Math.round(new Date().getTime() / 8.64e7);
  let url = `${apiurl}collection-submission?timestamp=${timestamp}`;

  if (location) {
    url += `&location_id=${location}`;
  }

  return from(
    axios.get(url, {
      headers: {
        "Content-Type": "application/json"
      }
    })
  ).pipe(
    pluck("data", "results"),
    map(results => {
      results.forEach(d => {
        d["dateCollected"] = parseDate(d.date_collected);
        d["dateSubmitted"] = parseDate(d.date_submitted);
        const gap = timeDay.count(d.dateCollected, d.dateSubmitted);
        // duplicate the gap by the number of sequences with the same collection / submission date
        d["gap"] = Array(d.total_count).fill(gap);
      });

      const firstDate = min(results, d => d.dateSubmitted);

      results.forEach(d => {
        // number of weeks between the submitted date and the first date.
        // Monday-based week.
        d["week"] = timeMonday.count(firstDate, d.dateSubmitted);
      })

      // calculations
      const gaps = results.flatMap(d => d.gap);
      const medianGap = median(gaps);
      const weeklyThresholds = range(0, max(gaps) + 7, 7);
      const binFunc = bin()
        .thresholds(weeklyThresholds)
      const binned = binFunc(gaps);

      // weekly summary of median submission date
      const weeklyMedian = nest()
        .key(d => d.week)
        .rollup(values => {
          return ({
            // values: values,
            week: values[0].week,
            total_count: values.flatMap(d => d.gap).length,
            minDate: min(values, d => d.dateSubmitted),
            maxDate: max(values, d => d.dateSubmitted),
            median: median(values.flatMap(d => d.gap)),
            quartile25: quantile(values.flatMap(d => d.gap), 0.25),
            quartile75: quantile(values.flatMap(d => d.gap), 0.75)
          })
        })
        .entries(results)
        .map(d => d.value);

      weeklyMedian.sort((a, b) => a.week - b.week);

      return ({
        data: results,
        gapHist: binned,
        weeklyMedian: weeklyMedian,
        median: medianGap
      })
    }),
    catchError(e => {
      console.log("%c Error in getting sequencing gap data!", "color: turquoise");
      console.log(e);
      return ( of ([]));
    }),
    finalize(() => store.state.genomics.locationLoading1 = false)
  )
}


export function checkGisaidID(apiurl, id) {
  store.state.genomics.locationLoading2 = true;
  const timestamp = Math.round(new Date().getTime() / 8.64e7);
  const url = `${apiurl}gisaid-id-lookup?id=${id}&timestamp=${timestamp}`;

  return from(
    axios.get(url, {
      headers: {
        "Content-Type": "application/json"
      }
    })
  ).pipe(
    pluck("data", "exists"),
    map(results => {
      return (results)
    }),
    catchError(e => {
      console.log("%c Error looking up GISAID ID!", "color: turquoise");
      console.log(e);
      return ( of ([]));
    }),
    finalize(() => store.state.genomics.locationLoading2 = false)
  )
}

export function getSeqMap(apiurl, epiurl, location) {
  store.state.genomics.locationLoading3 = true;
  const timestamp = Math.round(new Date().getTime() / 8.64e7);

  return (forkJoin([getSequenceCount(apiurl, location, true, true)])).pipe(
    map(([results]) => {
      return (results)
    }),
    catchError(e => {
      console.log("%c Error grabbing sequence counts map!", "color: turquoise");
      console.log(e);
      return ( of ([]));
    }),
    finalize(() => store.state.genomics.locationLoading3 = false)
  )
}
